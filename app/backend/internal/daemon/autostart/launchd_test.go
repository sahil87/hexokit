package autostart

import (
	"context"
	"encoding/xml"
	"errors"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// launchdFakeResp is one canned command outcome.
type launchdFakeResp struct {
	out  string
	code int
	err  error
}

// launchdFake records every command the backend runs and answers from resp,
// keyed by the longest matching "name arg…" prefix; unmatched commands
// succeed with no output.
type launchdFake struct {
	calls []string
	resp  map[string]launchdFakeResp
}

func (f *launchdFake) run(_ context.Context, name string, args ...string) ([]byte, int, error) {
	line := strings.Join(append([]string{name}, args...), " ")
	f.calls = append(f.calls, line)
	best := ""
	for k := range f.resp {
		if strings.HasPrefix(line, k) && len(k) > len(best) {
			best = k
		}
	}
	if best == "" {
		return nil, 0, nil
	}
	r := f.resp[best]
	return []byte(r.out), r.code, r.err
}

// mutations are the launchctl calls that change launchd state.
func (f *launchdFake) mutations() []string {
	var out []string
	for _, c := range f.calls {
		for _, verb := range []string{"enable", "bootstrap", "bootout", "kickstart", "disable"} {
			if strings.HasPrefix(c, "launchctl "+verb+" ") {
				out = append(out, c)
			}
		}
	}
	return out
}

const (
	launchdTestRK      = "/opt/homebrew/bin/hexokit"
	launchdTestService = "gui/501/ai.shll.hexokit.daemon"
)

// launchdNotLoaded is launchctl's answer for an unknown service.
var launchdNotLoaded = launchdFakeResp{out: "Could not find service \"ai.shll.hexokit.daemon\" in domain for user gui: 501", code: 113}

func newLaunchdTest(t *testing.T, f *launchdFake) (*launchd, string) {
	t.Helper()
	if f.resp == nil {
		f.resp = map[string]launchdFakeResp{}
	}
	if _, ok := f.resp["dscl"]; !ok {
		f.resp["dscl"] = launchdFakeResp{out: "UserShell: /bin/zsh\n"}
	}
	if _, ok := f.resp["launchctl print "+launchdTestService]; !ok {
		f.resp["launchctl print "+launchdTestService] = launchdNotLoaded
	}
	home := t.TempDir()
	logs := filepath.Join(t.TempDir(), "state", "logs")
	return &launchd{
		run:      f.run,
		homeDir:  func() (string, error) { return home, nil },
		uid:      func() int { return 501 },
		username: func() (string, error) { return "tester", nil },
		rkPath:   func() (string, error) { return launchdTestRK, nil },
		logsDir:  func() (string, error) { return logs, nil },
	}, launchdPlistPath(home)
}

// launchdParsePlist decodes the flat dict the backend writes into key →
// string / bool / []string, failing the test on malformed XML.
func launchdParsePlist(t *testing.T, data []byte) map[string]any {
	t.Helper()
	dec := xml.NewDecoder(strings.NewReader(string(data)))
	dec.Strict = true
	out := map[string]any{}
	var key string
	var inArray bool
	var arr []string
	var text strings.Builder
	for {
		tok, err := dec.Token()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			t.Fatalf("plist is not well-formed XML: %v\n%s", err, data)
		}
		switch el := tok.(type) {
		case xml.StartElement:
			text.Reset()
			switch el.Name.Local {
			case "array":
				inArray, arr = true, nil
			case "true", "false":
				out[key] = el.Name.Local == "true"
			}
		case xml.CharData:
			text.Write(el)
		case xml.EndElement:
			switch el.Name.Local {
			case "key":
				key = text.String()
			case "string":
				if inArray {
					arr = append(arr, text.String())
				} else {
					out[key] = text.String()
				}
			case "array":
				out[key] = arr
				inArray = false
			}
		}
	}
	return out
}

func TestLaunchd_RegisteredForDarwin(t *testing.T) {
	b, err := For("darwin")
	if err != nil {
		t.Fatalf("For(darwin): %v", err)
	}
	if _, ok := b.(*launchd); !ok {
		t.Fatalf("For(darwin) = %T, want *launchd", b)
	}
}

func TestLaunchdPlist_Shape(t *testing.T) {
	data := launchdPlist("/bin/zsh", StartScript(launchdTestRK, nil), "/Users/t/.local/state/hexokit/logs/autostart.log")
	if !strings.Contains(string(data), "<!-- "+ManagedMarker+" -->") {
		t.Errorf("plist lacks the managed marker comment:\n%s", data)
	}
	got := launchdParsePlist(t, data)
	want := map[string]any{
		"Label":               "ai.shll.hexokit.daemon",
		"ProgramArguments":    []string{"/bin/zsh", "-lc", `exec '/opt/homebrew/bin/hexokit' daemon start --if-not-running`},
		"RunAtLoad":           true,
		"AbandonProcessGroup": true,
		"StandardOutPath":     "/Users/t/.local/state/hexokit/logs/autostart.log",
		"StandardErrorPath":   "/Users/t/.local/state/hexokit/logs/autostart.log",
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("plist dict = %#v\nwant %#v", got, want)
	}
}

func TestLaunchdPlist_EscapesXMLSpecials(t *testing.T) {
	shell := "/Users/a&b/<sh>"
	rk := `/Users/o'neil & co/"bin"/rk`
	data := launchdPlist(shell, StartScript(rk, nil), "/tmp/l<o>g")
	got := launchdParsePlist(t, data)
	args, _ := got["ProgramArguments"].([]string)
	if len(args) != 3 || args[0] != shell || args[2] != StartScript(rk, nil) {
		t.Errorf("ProgramArguments did not round-trip: %#v", args)
	}
	if got["StandardErrorPath"] != "/tmp/l<o>g" {
		t.Errorf("log path did not round-trip: %#v", got["StandardErrorPath"])
	}
}

func TestLaunchd_LoginShell(t *testing.T) {
	tests := []struct {
		name string
		resp launchdFakeResp
		user error
		want string
	}{
		{"dscl answer", launchdFakeResp{out: "UserShell: /opt/homebrew/bin/fish\n"}, nil, "/opt/homebrew/bin/fish"},
		{"dscl fails", launchdFakeResp{out: "<dscl_cmd> DS Error", code: 56}, nil, "/bin/zsh"},
		{"dscl cannot run", launchdFakeResp{err: errors.New("not found")}, nil, "/bin/zsh"},
		{"no UserShell line", launchdFakeResp{out: "RecordName: tester\n"}, nil, "/bin/zsh"},
		{"relative value", launchdFakeResp{out: "UserShell: zsh\n"}, nil, "/bin/zsh"},
		{"unknown user", launchdFakeResp{}, errors.New("no user"), "/bin/zsh"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Setenv("SHELL", "/bin/should-not-be-read")
			f := &launchdFake{resp: map[string]launchdFakeResp{"dscl": tt.resp}}
			l, _ := newLaunchdTest(t, f)
			if tt.user != nil {
				l.username = func() (string, error) { return "", tt.user }
			}
			if got := l.loginShell(context.Background()); got != tt.want {
				t.Errorf("loginShell() = %q, want %q", got, tt.want)
			}
			if tt.user == nil && (len(f.calls) != 1 || f.calls[0] != "dscl . -read /Users/tester UserShell") {
				t.Errorf("calls = %q", f.calls)
			}
		})
	}
}

func TestLaunchdOn_RegistersWithoutStarting(t *testing.T) {
	f := &launchdFake{}
	l, path := newLaunchdTest(t, f)

	res, err := l.On(context.Background(), OnOptions{})
	if err != nil {
		t.Fatalf("On: %v", err)
	}
	if !res.Changed || res.Started || res.Path != path || res.Name != launchdLabel {
		t.Errorf("result = %+v", res)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("plist not written: %v", err)
	}
	if info.Mode().Perm() != 0o644 {
		t.Errorf("plist mode = %v, want 0644", info.Mode().Perm())
	}
	logs, _ := l.logsDir()
	if _, err := os.Stat(logs); err != nil {
		t.Errorf("logs dir not created: %v", err)
	}
	if got, want := f.mutations(), []string{"launchctl enable " + launchdTestService}; !reflect.DeepEqual(got, want) {
		t.Errorf("launchctl mutations = %q, want %q", got, want)
	}

	f.calls = nil
	before, _ := os.ReadFile(path)
	res, err = l.On(context.Background(), OnOptions{})
	if err != nil {
		t.Fatalf("second On: %v", err)
	}
	after, _ := os.ReadFile(path)
	if res.Changed || string(before) != string(after) {
		t.Errorf("second On changed=%v; want an idempotent no-op", res.Changed)
	}
}

func TestLaunchdOn_Now(t *testing.T) {
	tests := []struct {
		name      string
		preWrite  bool
		loaded    bool
		wantMut   []string
		wantChang bool
	}{
		{
			name:      "not loaded bootstraps",
			wantMut:   []string{"launchctl enable " + launchdTestService, "launchctl bootstrap gui/501 {path}"},
			wantChang: true,
		},
		{
			name:     "loaded and unchanged kickstarts",
			preWrite: true,
			loaded:   true,
			wantMut:  []string{"launchctl enable " + launchdTestService, "launchctl kickstart " + launchdTestService},
		},
		{
			name:      "loaded and changed reloads",
			loaded:    true,
			wantMut:   []string{"launchctl enable " + launchdTestService, "launchctl bootout " + launchdTestService, "launchctl bootstrap gui/501 {path}"},
			wantChang: true,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			f := &launchdFake{resp: map[string]launchdFakeResp{}}
			if tt.loaded {
				f.resp["launchctl print "+launchdTestService] = launchdFakeResp{out: "state = not running\n\tlast exit code = 0\n"}
			}
			l, path := newLaunchdTest(t, f)
			if tt.preWrite {
				if _, err := l.On(context.Background(), OnOptions{}); err != nil {
					t.Fatalf("pre-write On: %v", err)
				}
				f.calls = nil
			}

			res, err := l.On(context.Background(), OnOptions{Now: true})
			if err != nil {
				t.Fatalf("On(Now): %v", err)
			}
			if !res.Started || res.Changed != tt.wantChang {
				t.Errorf("result = %+v, want Started and Changed=%v", res, tt.wantChang)
			}
			var want []string
			for _, m := range tt.wantMut {
				want = append(want, strings.ReplaceAll(m, "{path}", path))
			}
			if got := f.mutations(); !reflect.DeepEqual(got, want) {
				t.Errorf("launchctl mutations = %q\nwant %q", got, want)
			}
		})
	}
}

func TestLaunchdOn_BootstrapFailureSurfaces(t *testing.T) {
	f := &launchdFake{resp: map[string]launchdFakeResp{
		"launchctl bootstrap": {out: "Bootstrap failed: 5: Input/output error", code: 5},
	}}
	l, _ := newLaunchdTest(t, f)

	res, err := l.On(context.Background(), OnOptions{Now: true})
	if err == nil {
		t.Fatal("On(Now) with a failing bootstrap returned nil error")
	}
	if !strings.Contains(err.Error(), "launchctl bootstrap gui/501") || !strings.Contains(err.Error(), "Input/output error") {
		t.Errorf("error = %q, want the command and its output", err)
	}
	if res.Started {
		t.Error("Started = true after a failed bootstrap")
	}
}

func TestLaunchdOn_RefusesForeignPlist(t *testing.T) {
	f := &launchdFake{}
	l, path := newLaunchdTest(t, f)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	foreign := []byte("<plist><dict><key>Label</key><string>mine</string></dict></plist>")
	if err := os.WriteFile(path, foreign, 0o644); err != nil {
		t.Fatal(err)
	}

	if _, err := l.On(context.Background(), OnOptions{Now: true}); err == nil || !strings.Contains(err.Error(), "not written by rk daemon autostart") {
		t.Fatalf("On over a foreign plist: err = %v", err)
	}
	if got, _ := os.ReadFile(path); string(got) != string(foreign) {
		t.Error("foreign plist was modified")
	}
	if m := f.mutations(); len(m) != 0 {
		t.Errorf("launchctl mutations on refusal: %q", m)
	}
}

func TestLaunchdOff(t *testing.T) {
	t.Run("registered and loaded", func(t *testing.T) {
		f := &launchdFake{resp: map[string]launchdFakeResp{}}
		l, path := newLaunchdTest(t, f)
		if _, err := l.On(context.Background(), OnOptions{}); err != nil {
			t.Fatal(err)
		}
		f.resp["launchctl print "+launchdTestService] = launchdFakeResp{out: "last exit code = 0\n"}
		f.calls = nil

		res, err := l.Off(context.Background())
		if err != nil {
			t.Fatalf("Off: %v", err)
		}
		if !res.Changed {
			t.Errorf("result = %+v, want Changed", res)
		}
		if _, err := os.Stat(path); !os.IsNotExist(err) {
			t.Errorf("plist still present: %v", err)
		}
		if got, want := f.mutations(), []string{"launchctl bootout " + launchdTestService}; !reflect.DeepEqual(got, want) {
			t.Errorf("launchctl mutations = %q, want %q", got, want)
		}
		for _, c := range f.calls {
			if !strings.HasPrefix(c, "launchctl ") {
				t.Errorf("Off ran %q; only launchctl is allowed (never rk daemon stop)", c)
			}
		}
	})

	t.Run("absent is a no-op", func(t *testing.T) {
		f := &launchdFake{}
		l, _ := newLaunchdTest(t, f)
		res, err := l.Off(context.Background())
		if err != nil {
			t.Fatalf("Off: %v", err)
		}
		if res.Changed {
			t.Error("Changed = true with nothing registered")
		}
		if m := f.mutations(); len(m) != 0 {
			t.Errorf("launchctl mutations = %q, want none", m)
		}
	})

	t.Run("foreign plist is refused", func(t *testing.T) {
		f := &launchdFake{resp: map[string]launchdFakeResp{
			"launchctl print " + launchdTestService: {out: "last exit code = 0\n"},
		}}
		l, path := newLaunchdTest(t, f)
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte("<plist/>"), 0o644); err != nil {
			t.Fatal(err)
		}
		if _, err := l.Off(context.Background()); err == nil {
			t.Fatal("Off over a foreign plist returned nil error")
		}
		if _, err := os.Stat(path); err != nil {
			t.Errorf("foreign plist removed: %v", err)
		}
		if m := f.mutations(); len(m) != 0 {
			t.Errorf("launchctl mutations = %q, want none", m)
		}
	})
}

func TestLaunchdStatus(t *testing.T) {
	type check func(t *testing.T, st Status)
	exit := func(want int) check {
		return func(t *testing.T, st Status) {
			if st.LastExitCode == nil || *st.LastExitCode != want {
				t.Errorf("LastExitCode = %v, want %d", st.LastExitCode, want)
			}
		}
	}
	noExit := func(t *testing.T, st Status) {
		if st.LastExitCode != nil {
			t.Errorf("LastExitCode = %d, want nil", *st.LastExitCode)
		}
	}
	hint := func(sub string) check {
		return func(t *testing.T, st Status) {
			for _, h := range st.Hints {
				if strings.Contains(h, sub) {
					return
				}
			}
			t.Errorf("hints %q lack %q", st.Hints, sub)
		}
	}

	tests := []struct {
		name     string
		register bool
		tamper   bool
		print    *launchdFakeResp
		disabled string
		want     Status
		checks   []check
	}{
		{
			name:   "not registered",
			want:   Status{},
			checks: []check{noExit, hint("rk daemon autostart on")},
		},
		{
			name:     "loaded, last start succeeded",
			register: true,
			print:    &launchdFakeResp{out: "gui/501/ai.shll.hexokit.daemon = {\n\tstate = not running\n\tlast exit code = 0\n}\n"},
			want:     Status{Registered: true, Enabled: true, StartsAt: StartsAtLogin, LastResult: "success"},
			checks:   []check{exit(0), hint("~/.zprofile but not ~/.zshrc")},
		},
		{
			name:     "signal exit",
			register: true,
			print:    &launchdFakeResp{out: "\tlast exit code = 9: Killed\n"},
			want:     Status{Registered: true, Enabled: true, StartsAt: StartsAtLogin, LastResult: "failed"},
			checks:   []check{exit(9), hint("autostart.log")},
		},
		{
			name:     "never exited",
			register: true,
			print:    &launchdFakeResp{out: "\tlast exit code = (never exited)\n"},
			want:     Status{Registered: true, Enabled: true, StartsAt: StartsAtLogin, LastResult: "never run"},
			checks:   []check{noExit},
		},
		{
			name:     "registered but not loaded yet",
			register: true,
			want:     Status{Registered: true, Enabled: true, StartsAt: StartsAtLogin, LastResult: "not loaded"},
			checks:   []check{noExit},
		},
		{
			name:     "disabled by launchctl",
			register: true,
			disabled: "disabled services = {\n\t\"com.apple.x\" => enabled\n\t\"ai.shll.hexokit.daemon\" => disabled\n}\n",
			want:     Status{Registered: true, StartsAt: StartsAtLogin, LastResult: "not loaded"},
			checks:   []check{hint("disabled")},
		},
		{
			name:     "disabled on an older macOS",
			register: true,
			disabled: "\t\"ai.shll.hexokit.daemon\" => true\n",
			want:     Status{Registered: true, StartsAt: StartsAtLogin, LastResult: "not loaded"},
		},
		{
			name:     "stale registration",
			register: true,
			tamper:   true,
			want:     Status{Registered: true, Enabled: true, StartsAt: StartsAtLogin, LastResult: "not loaded", Stale: true},
			checks:   []check{hint("refresh it")},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			f := &launchdFake{resp: map[string]launchdFakeResp{}}
			if tt.print != nil {
				f.resp["launchctl print "+launchdTestService] = *tt.print
			}
			if tt.disabled != "" {
				f.resp["launchctl print-disabled"] = launchdFakeResp{out: tt.disabled}
			}
			l, path := newLaunchdTest(t, f)
			if tt.register {
				if _, err := l.On(context.Background(), OnOptions{}); err != nil {
					t.Fatal(err)
				}
			}
			if tt.tamper {
				data, _ := os.ReadFile(path)
				stale := strings.Replace(string(data), launchdTestRK, "/usr/local/Cellar/hexokit/1.0/bin/hexokit", 1)
				if err := os.WriteFile(path, []byte(stale), 0o644); err != nil {
					t.Fatal(err)
				}
			}
			f.calls = nil

			st, err := l.Status(context.Background())
			if err != nil {
				t.Fatalf("Status: %v", err)
			}
			if st.Platform != "darwin" || st.Manager != "launchd" || st.Name != launchdLabel || st.Path != path {
				t.Errorf("identity = %+v", st)
			}
			if st.RKPath != launchdTestRK || st.Shell != "/bin/zsh" || st.Linger != nil {
				t.Errorf("rk_path/shell/linger = %q/%q/%v", st.RKPath, st.Shell, st.Linger)
			}
			if st.Registered != tt.want.Registered || st.Enabled != tt.want.Enabled || st.StartsAt != tt.want.StartsAt ||
				st.LastResult != tt.want.LastResult || st.Stale != tt.want.Stale {
				t.Errorf("status = %+v\nwant  %+v", st, tt.want)
			}
			for _, c := range tt.checks {
				c(t, st)
			}
			if m := f.mutations(); len(m) != 0 {
				t.Errorf("Status mutated launchd: %q", m)
			}
		})
	}
}

func TestLaunchdRCHint(t *testing.T) {
	tests := map[string]string{
		"/bin/zsh":                   "~/.zshrc",
		"/opt/homebrew/bin/bash":     "~/.bashrc",
		"/opt/homebrew/bin/fish":     "",
		"/usr/local/bin/nushell-bin": "",
	}
	for shell, want := range tests {
		got := launchdRCHint(shell)
		if want == "" && got != "" {
			t.Errorf("launchdRCHint(%q) = %q, want none", shell, got)
		}
		if want != "" && !strings.Contains(got, want) {
			t.Errorf("launchdRCHint(%q) = %q, want it to name %s", shell, got, want)
		}
	}
}
