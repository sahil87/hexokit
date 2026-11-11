package autostart

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

const (
	systemdTestUser  = "sahil"
	systemdTestShell = "/usr/bin/zsh"
	systemdTestRK    = "/home/linuxbrew/.linuxbrew/bin/rk"
)

// systemdFakeRun records every subprocess and answers from a table keyed by the
// joined argv; an unlisted call succeeds with empty output.
type systemdFakeRun struct {
	calls    []string
	timeouts map[string]time.Duration
	out      map[string]string
	fail     map[string]bool
}

func newSystemdFakeRun() *systemdFakeRun {
	return &systemdFakeRun{
		timeouts: map[string]time.Duration{},
		out: map[string]string{
			"getent passwd sahil":                            "sahil:x:1000:1000::/home/sahil:/usr/bin/zsh\n",
			"loginctl show-user sahil -p Linger --value":     "no\n",
			"systemctl --user is-enabled " + systemdUnitName: "not-found\n",
		},
		fail: map[string]bool{
			"systemctl --user is-enabled " + systemdUnitName: true,
		},
	}
}

func (f *systemdFakeRun) run(_ context.Context, timeout time.Duration, name string, args ...string) ([]byte, error) {
	call := strings.Join(append([]string{name}, args...), " ")
	f.calls = append(f.calls, call)
	f.timeouts[call] = timeout
	out := []byte(f.out[call])
	if f.fail[call] {
		return out, errors.New("exit status 1")
	}
	return out, nil
}

// mutating returns the calls that change systemd state, in order.
func (f *systemdFakeRun) mutating() []string {
	var out []string
	for _, c := range f.calls {
		for _, verb := range []string{"daemon-reload", " enable ", " disable ", " restart ", " start ", " stop ", " kill "} {
			if strings.Contains(c+" ", verb) {
				out = append(out, c)
				break
			}
		}
	}
	return out
}

func (f *systemdFakeRun) setEnabled(on bool) {
	key := "systemctl --user is-enabled " + systemdUnitName
	if on {
		f.out[key] = "enabled\n"
		f.fail[key] = false
	} else {
		f.out[key] = "disabled\n"
		f.fail[key] = true
	}
}

func newSystemdTestBackend(t *testing.T, f *systemdFakeRun) (*systemd, string) {
	t.Helper()
	dir := t.TempDir()
	s := &systemd{
		run:        f.run,
		configDir:  func() (string, error) { return dir, nil },
		username:   func() (string, error) { return systemdTestUser, nil },
		lookPath:   func(string) (string, error) { return "/usr/bin/systemctl", nil },
		booted:     func() bool { return true },
		rkPath:     func() (string, error) { return systemdTestRK, nil },
		getenv:     func(string) string { return "" },
		executable: func(string) bool { return true },
	}
	return s, filepath.Join(dir, "systemd", "user", systemdUnitName)
}

const systemdGoldenUnit = `# Managed by rk daemon autostart — rewritten by ` + "`rk daemon autostart on`" + `, removed by ` + "`off`" + `. Do not edit.
[Unit]
Description=HexoKit daemon (started once at boot/login, not supervised)

[Service]
Type=oneshot
RemainAfterExit=yes
KillMode=process
TimeoutStartSec=90
ExecStart=/usr/bin/zsh -lc "exec env -u 'INVOCATION_ID' -u 'JOURNAL_STREAM' -u 'MANAGERPID' -u 'SYSTEMD_EXEC_PID' -u 'MEMORY_PRESSURE_WATCH' -u 'MEMORY_PRESSURE_WRITE' '/home/linuxbrew/.linuxbrew/bin/rk' daemon start --if-not-running"

[Install]
WantedBy=default.target
`

func TestSystemdRegistered(t *testing.T) {
	b, err := For("linux")
	if err != nil {
		t.Fatalf("For(linux): %v", err)
	}
	if _, ok := b.(*systemd); !ok {
		t.Fatalf("For(linux) = %T, want *systemd", b)
	}
}

func TestSystemdRenderUnitGolden(t *testing.T) {
	got, err := systemdRenderUnit(systemdTestShell, systemdTestRK)
	if err != nil {
		t.Fatal(err)
	}
	if got != systemdGoldenUnit {
		t.Errorf("unit mismatch\n--- got ---\n%s\n--- want ---\n%s", got, systemdGoldenUnit)
	}
	if strings.Contains(got, "Restart=") {
		t.Error("unit must never carry Restart= (start once, never supervise)")
	}
}

func TestSystemdRenderUnitEscaping(t *testing.T) {
	got, err := systemdRenderUnit(systemdTestShell, `/home/a b/100%/$HOME/"x"/rk`)
	if err != nil {
		t.Fatal(err)
	}
	want := `'/home/a b/100%%/$$HOME/\"x\"/rk' daemon start`
	if !strings.Contains(got, want) {
		t.Errorf("ExecStart does not carry the escaped path %s\n%s", want, got)
	}

	got, err = systemdRenderUnit(systemdTestShell, `/opt/it's/rk`)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(got, `'/opt/it'\\''s/rk'`) {
		t.Errorf("shell quote escape not systemd-escaped:\n%s", got)
	}
}

func TestSystemdRenderUnitRejectsUnsafePaths(t *testing.T) {
	cases := []struct{ shell, rk string }{
		{systemdTestShell, "bin/rk"},
		{systemdTestShell, "/opt/rk\nExecStartPost=/bin/evil"},
		{systemdTestShell, "/opt/rk\x7f"},
		{"zsh", systemdTestRK},
		{"/usr/bin/my shell", systemdTestRK},
		{"/usr/sbin/nologin", systemdTestRK},
		{"/bin/false", systemdTestRK},
		{`/usr/bin/it's`, systemdTestRK},
		{systemdTestShell, `/opt/back\slash/rk`},
	}
	for _, c := range cases {
		if _, err := systemdRenderUnit(c.shell, c.rk); err == nil {
			t.Errorf("systemdRenderUnit(%q, %q) succeeded, want an error", c.shell, c.rk)
		}
	}
}

func TestSystemdLoginShell(t *testing.T) {
	f := newSystemdFakeRun()
	s, _ := newSystemdTestBackend(t, f)
	if got, err := s.loginShell(context.Background(), systemdTestUser); err != nil || got != systemdTestShell {
		t.Errorf("passwd shell = %q, %v; want %q", got, err, systemdTestShell)
	}
	if f.timeouts["getent passwd sahil"] != systemdLookupTimeout {
		t.Errorf("getent timeout = %v, want %v", f.timeouts["getent passwd sahil"], systemdLookupTimeout)
	}

	f.fail["getent passwd sahil"] = true
	s.getenv = func(k string) string {
		if k == "SHELL" {
			return "/bin/bash"
		}
		return ""
	}
	if got, _ := s.loginShell(context.Background(), systemdTestUser); got != "/bin/bash" {
		t.Errorf("$SHELL fallback = %q, want /bin/bash", got)
	}

	s.getenv = func(string) string { return "" }
	if got, _ := s.loginShell(context.Background(), systemdTestUser); got != systemdFallbackShell {
		t.Errorf("last-resort fallback = %q, want %q", got, systemdFallbackShell)
	}

	f.fail["getent passwd sahil"] = false
	f.out["getent passwd sahil"] = "sahil:x:1000:1000::/home/sahil:\n"
	s.getenv = func(string) string { return "/bin/bash" }
	if got, _ := s.loginShell(context.Background(), systemdTestUser); got != systemdFallbackShell {
		t.Errorf("empty passwd shell field = %q, want %q (passwd(5)), not $SHELL", got, systemdFallbackShell)
	}

	f.out["getent passwd sahil"] = "sahil:x:1000:1000::/home/sahil:/usr/sbin/nologin\n"
	if _, err := s.loginShell(context.Background(), systemdTestUser); err == nil {
		t.Error("nologin shell accepted")
	}

	f.out["getent passwd sahil"] = "sahil:x:1000:1000::/home/sahil:/usr/bin/zsh\n"
	s.executable = func(string) bool { return false }
	if _, err := s.loginShell(context.Background(), systemdTestUser); err == nil {
		t.Error("non-executable shell accepted")
	}
}

func TestSystemdMissing(t *testing.T) {
	ctx := context.Background()
	for name, mutate := range map[string]func(*systemd){
		"no systemctl": func(s *systemd) { s.lookPath = func(string) (string, error) { return "", errors.New("not found") } },
		"not booted":   func(s *systemd) { s.booted = func() bool { return false } },
	} {
		t.Run(name, func(t *testing.T) {
			f := newSystemdFakeRun()
			s, _ := newSystemdTestBackend(t, f)
			mutate(s)
			_, onErr := s.On(ctx, OnOptions{Now: true})
			_, offErr := s.Off(ctx)
			_, stErr := s.Status(ctx)
			for verb, err := range map[string]error{"on": onErr, "off": offErr, "status": stErr} {
				if !errors.Is(err, systemdErrMissing) {
					t.Errorf("%s: err = %v, want systemdErrMissing", verb, err)
				}
			}
			if !strings.Contains(systemdErrMissing.Error(), "Linux") {
				t.Errorf("error does not name the platform: %v", systemdErrMissing)
			}
			if len(f.calls) != 0 {
				t.Errorf("ran subprocesses without systemd: %v", f.calls)
			}
		})
	}
}

func TestSystemdOnFirstRunThenNoop(t *testing.T) {
	ctx := context.Background()
	f := newSystemdFakeRun()
	s, path := newSystemdTestBackend(t, f)

	res, err := s.On(ctx, OnOptions{})
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(path)
	if err != nil || string(data) != systemdGoldenUnit {
		t.Fatalf("unit file = %q, %v; want the golden unit", data, err)
	}
	want := []string{
		"systemctl --user daemon-reload",
		"systemctl --user enable " + systemdUnitName,
	}
	if got := f.mutating(); !reflect.DeepEqual(got, want) {
		t.Errorf("mutating calls = %v, want %v", got, want)
	}
	if !res.Changed || res.Started || res.Name != systemdUnitName || res.Path != path {
		t.Errorf("result = %+v", res)
	}
	if !systemdHasHint(res.Hints, "loginctl enable-linger sahil") || !systemdHasHint(res.Hints, "~/.zprofile") {
		t.Errorf("hints = %v, want linger and profile advice", res.Hints)
	}
	for _, c := range f.calls {
		if strings.HasPrefix(c, "systemctl") && f.timeouts[c] != systemdCtlTimeout {
			t.Errorf("%s timeout = %v, want %v", c, f.timeouts[c], systemdCtlTimeout)
		}
	}

	f.calls = nil
	f.setEnabled(true)
	res, err = s.On(ctx, OnOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if res.Changed {
		t.Error("second on reported Changed")
	}
	if got := f.mutating(); len(got) != 0 {
		t.Errorf("second on mutated systemd: %v", got)
	}
}

func TestSystemdOnRewritesStaleUnit(t *testing.T) {
	f := newSystemdFakeRun()
	s, path := newSystemdTestBackend(t, f)
	if _, err := s.On(context.Background(), OnOptions{}); err != nil {
		t.Fatal(err)
	}
	f.calls = nil
	f.setEnabled(true)
	s.rkPath = func() (string, error) { return "/usr/local/bin/rk", nil }
	res, err := s.On(context.Background(), OnOptions{})
	if err != nil {
		t.Fatal(err)
	}
	data, _ := os.ReadFile(path)
	if !res.Changed || !strings.Contains(string(data), "'/usr/local/bin/rk'") {
		t.Errorf("unit not rewritten: changed=%v\n%s", res.Changed, data)
	}
	if got := f.mutating(); !reflect.DeepEqual(got, []string{"systemctl --user daemon-reload"}) {
		t.Errorf("mutating calls = %v, want only daemon-reload", got)
	}
}

func TestSystemdOnNowRestarts(t *testing.T) {
	f := newSystemdFakeRun()
	s, _ := newSystemdTestBackend(t, f)
	res, err := s.On(context.Background(), OnOptions{Now: true})
	if err != nil {
		t.Fatal(err)
	}
	want := []string{
		"systemctl --user daemon-reload",
		"systemctl --user enable " + systemdUnitName,
		"systemctl --user restart " + systemdUnitName,
	}
	if got := f.mutating(); !reflect.DeepEqual(got, want) {
		t.Errorf("mutating calls = %v, want %v", got, want)
	}
	if !res.Started {
		t.Error("Started = false after --now")
	}
	if got := f.timeouts["systemctl --user restart "+systemdUnitName]; got != systemdRestartTimeout {
		t.Errorf("restart timeout = %v, want %v", got, systemdRestartTimeout)
	}
}

func TestSystemdOnAndOffRefuseForeignUnit(t *testing.T) {
	f := newSystemdFakeRun()
	s, path := newSystemdTestBackend(t, f)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	foreign := "[Service]\nExecStart=/bin/true\n"
	if err := os.WriteFile(path, []byte(foreign), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := s.On(context.Background(), OnOptions{}); err == nil || !strings.Contains(err.Error(), "not managed") {
		t.Errorf("on over a foreign unit: err = %v", err)
	}
	if _, err := s.Off(context.Background()); err == nil || !strings.Contains(err.Error(), "not managed") {
		t.Errorf("off over a foreign unit: err = %v", err)
	}
	if data, _ := os.ReadFile(path); string(data) != foreign {
		t.Error("foreign unit was modified")
	}
	if got := f.mutating(); len(got) != 0 {
		t.Errorf("mutated systemd around a foreign unit: %v", got)
	}
}

func TestSystemdOnRejectsUnusableShell(t *testing.T) {
	f := newSystemdFakeRun()
	f.out["getent passwd sahil"] = "sahil:x:1000:1000::/home/sahil:/bin/false\n"
	s, path := newSystemdTestBackend(t, f)
	if _, err := s.On(context.Background(), OnOptions{}); err == nil {
		t.Fatal("on accepted /bin/false as the login shell")
	}
	if _, err := os.Stat(path); err == nil {
		t.Error("unit written despite the unusable shell")
	}
}

func TestSystemdOffNeverStops(t *testing.T) {
	ctx := context.Background()
	f := newSystemdFakeRun()
	s, path := newSystemdTestBackend(t, f)
	if _, err := s.On(ctx, OnOptions{}); err != nil {
		t.Fatal(err)
	}
	f.calls = nil
	f.setEnabled(true)

	res, err := s.Off(ctx)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{
		"systemctl --user disable " + systemdUnitName,
		"systemctl --user daemon-reload",
	}
	if got := f.mutating(); !reflect.DeepEqual(got, want) {
		t.Errorf("mutating calls = %v, want %v (and never stop)", got, want)
	}
	if _, err := os.Stat(path); err == nil {
		t.Error("unit file still present after off")
	}
	if !res.Changed {
		t.Error("off reported no change")
	}

	f.calls = nil
	f.setEnabled(false) // the fake does not model disable's effect
	res, err = s.Off(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if res.Changed || len(f.mutating()) != 0 {
		t.Errorf("second off: changed=%v calls=%v", res.Changed, f.calls)
	}
}

func TestSystemdOffDisablesUnitEnabledElsewhere(t *testing.T) {
	f := newSystemdFakeRun()
	s, _ := newSystemdTestBackend(t, f)
	f.setEnabled(true)
	res, err := s.Off(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if got := f.mutating(); !reflect.DeepEqual(got, []string{"systemctl --user disable " + systemdUnitName}) {
		t.Errorf("mutating calls = %v, want only disable", got)
	}
	if !res.Changed || !systemdHasHint(res.Hints, "outside") {
		t.Errorf("result = %+v", res)
	}
}

func TestSystemdStatusForeignUnit(t *testing.T) {
	f := newSystemdFakeRun()
	s, path := newSystemdTestBackend(t, f)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("[Service]\nExecStart=/bin/true\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	st, err := s.Status(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if st.Registered || !systemdHasHint(st.Hints, "not managed") {
		t.Errorf("registered=%v hints=%v for a foreign unit", st.Registered, st.Hints)
	}
}

func TestSystemdStatusProbeFailures(t *testing.T) {
	f := newSystemdFakeRun()
	s, _ := newSystemdTestBackend(t, f)
	if _, err := s.On(context.Background(), OnOptions{}); err != nil {
		t.Fatal(err)
	}
	// is-enabled exits non-zero printing not-found; show itself fails.
	f.out["systemctl --user is-enabled "+systemdUnitName] = "not-found\n"
	f.fail["systemctl --user is-enabled "+systemdUnitName] = true
	f.fail["systemctl --user show "+systemdUnitName+" -p Result -p ExecMainStatus -p ExecMainStartTimestampMonotonic"] = true
	st, err := s.Status(context.Background())
	if err != nil {
		t.Fatalf("status failed on degraded probes: %v", err)
	}
	if st.Enabled || st.StartsAt != "" || st.LastResult != "" || st.LastExitCode != nil {
		t.Errorf("degraded status = %+v", st)
	}
}

func TestSystemdStatus(t *testing.T) {
	showKey := "systemctl --user show " + systemdUnitName + " -p Result -p ExecMainStatus -p ExecMainStartTimestampMonotonic"
	cases := []struct {
		name       string
		install    bool
		enabled    bool
		linger     string
		lingerFail bool
		show       string
		wantStarts string
		wantLinger *bool
		wantResult string
		wantCode   *int
		wantHint   string
	}{
		{name: "off", wantLinger: systemdPtr(false)},
		{name: "login", install: true, enabled: true, linger: "no",
			show:       "Result=success\nExecMainStatus=0\nExecMainStartTimestampMonotonic=123\n",
			wantStarts: StartsAtLogin, wantLinger: systemdPtr(false), wantResult: "success", wantCode: systemdPtr(0),
			wantHint: "loginctl enable-linger sahil"},
		{name: "boot", install: true, enabled: true, linger: "yes",
			show:       "Result=exit-code\nExecMainStatus=1\nExecMainStartTimestampMonotonic=123\n",
			wantStarts: StartsAtBoot, wantLinger: systemdPtr(true), wantResult: "exit-code", wantCode: systemdPtr(1)},
		{name: "linger unknown", install: true, enabled: true, lingerFail: true,
			show:       "Result=success\nExecMainStatus=0\nExecMainStartTimestampMonotonic=0\n",
			wantStarts: StartsAtLogin, wantHint: "cannot read the lingering state"},
		{name: "registered but disabled", install: true, linger: "yes", wantLinger: systemdPtr(true)},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			f := newSystemdFakeRun()
			s, path := newSystemdTestBackend(t, f)
			if c.install {
				if _, err := s.On(context.Background(), OnOptions{}); err != nil {
					t.Fatal(err)
				}
			}
			f.setEnabled(c.enabled)
			if c.linger != "" {
				f.out["loginctl show-user sahil -p Linger --value"] = c.linger + "\n"
			}
			f.fail["loginctl show-user sahil -p Linger --value"] = c.lingerFail
			f.out[showKey] = c.show

			st, err := s.Status(context.Background())
			if err != nil {
				t.Fatal(err)
			}
			if st.Platform != "linux" || st.Manager != "systemd" || st.Name != systemdUnitName || st.Path != path {
				t.Errorf("identity = %+v", st)
			}
			if st.Registered != c.install || st.Enabled != c.enabled || st.StartsAt != c.wantStarts {
				t.Errorf("registered=%v enabled=%v starts_at=%q", st.Registered, st.Enabled, st.StartsAt)
			}
			if !reflect.DeepEqual(st.Linger, c.wantLinger) {
				t.Errorf("linger = %v, want %v", systemdDeref(st.Linger), systemdDeref(c.wantLinger))
			}
			if st.LastResult != c.wantResult || !reflect.DeepEqual(st.LastExitCode, c.wantCode) {
				t.Errorf("last = %q/%v, want %q/%v", st.LastResult, systemdDeref(st.LastExitCode), c.wantResult, systemdDeref(c.wantCode))
			}
			if st.Shell != systemdTestShell || st.RKPath != systemdTestRK || st.Stale {
				t.Errorf("shell=%q rk=%q stale=%v", st.Shell, st.RKPath, st.Stale)
			}
			if c.wantHint != "" && !systemdHasHint(st.Hints, c.wantHint) {
				t.Errorf("hints = %v, want one containing %q", st.Hints, c.wantHint)
			}
			if got := f.mutating(); c.install == false && len(got) != 0 {
				t.Errorf("status mutated systemd: %v", got)
			}
		})
	}
}

func TestSystemdStatusStale(t *testing.T) {
	f := newSystemdFakeRun()
	s, _ := newSystemdTestBackend(t, f)
	if _, err := s.On(context.Background(), OnOptions{}); err != nil {
		t.Fatal(err)
	}
	f.out["getent passwd sahil"] = "sahil:x:1000:1000::/home/sahil:/bin/bash\n"
	st, err := s.Status(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !st.Stale || !systemdHasHint(st.Hints, "re-run it to refresh") {
		t.Errorf("stale=%v hints=%v after a chsh", st.Stale, st.Hints)
	}
	if !systemdHasHint(st.Hints, "~/.bashrc") {
		t.Errorf("profile hint does not follow the new shell: %v", st.Hints)
	}
}

func TestSystemdPasswdShell(t *testing.T) {
	cases := []struct {
		in        string
		want      string
		wantFound bool
	}{
		{"sahil:x:1000:1000:Sahil,,,:/home/sahil:/usr/bin/fish\n", "/usr/bin/fish", true},
		{"sahil:x:1000:1000::/home/sahil:\n", "", true},
		{"garbage", "", false},
		{"", "", false},
	}
	for _, c := range cases {
		if got, found := systemdPasswdShell([]byte(c.in)); got != c.want || found != c.wantFound {
			t.Errorf("systemdPasswdShell(%q) = %q, %v; want %q, %v", c.in, got, found, c.want, c.wantFound)
		}
	}
}

func systemdHasHint(hints []string, sub string) bool {
	for _, h := range hints {
		if strings.Contains(h, sub) {
			return true
		}
	}
	return false
}

func systemdPtr[T any](v T) *T { return &v }

func systemdDeref[T any](p *T) any {
	if p == nil {
		return nil
	}
	return *p
}
