package settings

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"testing"

	"rk/internal/portpolicy"
)

func TestDefault(t *testing.T) {
	s := Default()
	if s.Theme != "system" {
		t.Errorf("Default().Theme = %q, want %q", s.Theme, "system")
	}
	if s.ThemeDark != "default-dark" {
		t.Errorf("Default().ThemeDark = %q, want %q", s.ThemeDark, "default-dark")
	}
	if s.ThemeLight != "default-light" {
		t.Errorf("Default().ThemeLight = %q, want %q", s.ThemeLight, "default-light")
	}
	if s.TmuxConf != "" {
		t.Errorf("Default().TmuxConf = %q, want %q", s.TmuxConf, "")
	}
	if s.LogLevel != "info" {
		t.Errorf("Default().LogLevel = %q, want %q", s.LogLevel, "info")
	}
	if s.Port != 0 {
		t.Errorf("Default().Port = %d, want 0 (unset)", s.Port)
	}
}

func TestParseMissing(t *testing.T) {
	s := parse("")
	if s.Theme != "system" {
		t.Errorf("parse empty: Theme = %q, want %q", s.Theme, "system")
	}
	if s.ThemeDark != "default-dark" {
		t.Errorf("parse empty: ThemeDark = %q, want %q", s.ThemeDark, "default-dark")
	}
	if s.ThemeLight != "default-light" {
		t.Errorf("parse empty: ThemeLight = %q, want %q", s.ThemeLight, "default-light")
	}
}

func TestParseValid(t *testing.T) {
	s := parse("theme: dracula\ntheme_dark: dracula\ntheme_light: solarized-light\n")
	if s.Theme != "dracula" {
		t.Errorf("parse valid: Theme = %q, want %q", s.Theme, "dracula")
	}
	if s.ThemeDark != "dracula" {
		t.Errorf("parse valid: ThemeDark = %q, want %q", s.ThemeDark, "dracula")
	}
	if s.ThemeLight != "solarized-light" {
		t.Errorf("parse valid: ThemeLight = %q, want %q", s.ThemeLight, "solarized-light")
	}
}

func TestParseLegacy(t *testing.T) {
	s := parse("theme: dracula\n")
	if s.Theme != "dracula" {
		t.Errorf("parse legacy: Theme = %q, want %q", s.Theme, "dracula")
	}
	if s.ThemeDark != "default-dark" {
		t.Errorf("parse legacy: ThemeDark = %q, want %q", s.ThemeDark, "default-dark")
	}
	if s.ThemeLight != "default-light" {
		t.Errorf("parse legacy: ThemeLight = %q, want %q", s.ThemeLight, "default-light")
	}
}

func TestParseMalformed(t *testing.T) {
	s := parse("garbage line without colon\n")
	if s.Theme != "system" {
		t.Errorf("parse malformed: Theme = %q, want %q", s.Theme, "system")
	}
	if s.ThemeDark != "default-dark" {
		t.Errorf("parse malformed: ThemeDark = %q, want %q", s.ThemeDark, "default-dark")
	}
	if s.ThemeLight != "default-light" {
		t.Errorf("parse malformed: ThemeLight = %q, want %q", s.ThemeLight, "default-light")
	}
}

func TestParseEmptyValue(t *testing.T) {
	s := parse("theme: \ntheme_dark: \ntheme_light: \n")
	if s.Theme != "system" {
		t.Errorf("parse empty value: Theme = %q, want %q", s.Theme, "system")
	}
	if s.ThemeDark != "default-dark" {
		t.Errorf("parse empty value: ThemeDark = %q, want %q", s.ThemeDark, "default-dark")
	}
	if s.ThemeLight != "default-light" {
		t.Errorf("parse empty value: ThemeLight = %q, want %q", s.ThemeLight, "default-light")
	}
}

func TestParseWithComments(t *testing.T) {
	s := parse("# this is a comment\ntheme: nord\ntheme_dark: dracula\ntheme_light: solarized-light\n")
	if s.Theme != "nord" {
		t.Errorf("parse with comments: Theme = %q, want %q", s.Theme, "nord")
	}
	if s.ThemeDark != "dracula" {
		t.Errorf("parse with comments: ThemeDark = %q, want %q", s.ThemeDark, "dracula")
	}
	if s.ThemeLight != "solarized-light" {
		t.Errorf("parse with comments: ThemeLight = %q, want %q", s.ThemeLight, "solarized-light")
	}
}

func TestSaveAndLoad(t *testing.T) {
	// Use a temp directory to override HOME
	tmp := t.TempDir()
	t.Setenv("HOME", tmp)

	s := Settings{Theme: "system", ThemeDark: "dracula", ThemeLight: "solarized-light", CronTicker: true, EasterEggs: true}
	if err := Save(s); err != nil {
		t.Fatalf("Save: %v", err)
	}

	// Verify file was created at the fixed config root
	p := filepath.Join(tmp, ".config", "hexokit", "config.yaml")
	data, err := os.ReadFile(p)
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}
	want := "theme: system\ntheme_dark: dracula\ntheme_light: solarized-light\n"
	if got := string(data); got != want {
		t.Errorf("file content = %q, want %q", got, want)
	}

	// Load should return the saved values
	loaded := Load()
	if loaded.Theme != "system" {
		t.Errorf("Load().Theme = %q, want %q", loaded.Theme, "system")
	}
	if loaded.ThemeDark != "dracula" {
		t.Errorf("Load().ThemeDark = %q, want %q", loaded.ThemeDark, "dracula")
	}
	if loaded.ThemeLight != "solarized-light" {
		t.Errorf("Load().ThemeLight = %q, want %q", loaded.ThemeLight, "solarized-light")
	}
}

func TestSaveCreatesDir(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("HOME", tmp)

	// .config/hexokit/ does not exist yet
	configDir := filepath.Join(tmp, ".config", "hexokit")
	if _, err := os.Stat(configDir); !os.IsNotExist(err) {
		t.Fatal("expected .config/hexokit/ to not exist initially")
	}

	if err := Save(Settings{Theme: "nord", ThemeDark: "default-dark", ThemeLight: "default-light", CronTicker: true}); err != nil {
		t.Fatalf("Save: %v", err)
	}

	info, err := os.Stat(configDir)
	if err != nil {
		t.Fatalf("Stat .config/hexokit: %v", err)
	}
	if !info.IsDir() {
		t.Error(".config/hexokit should be a directory")
	}
}

func TestLoadMissingFile(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("HOME", tmp)

	s := Load()
	if s.Theme != "system" {
		t.Errorf("Load (missing): Theme = %q, want %q", s.Theme, "system")
	}
	if s.ThemeDark != "default-dark" {
		t.Errorf("Load (missing): ThemeDark = %q, want %q", s.ThemeDark, "default-dark")
	}
	if s.ThemeLight != "default-light" {
		t.Errorf("Load (missing): ThemeLight = %q, want %q", s.ThemeLight, "default-light")
	}
}

func TestSerialize(t *testing.T) {
	got := serialize(Settings{Theme: "catppuccin-mocha", ThemeDark: "catppuccin-mocha", ThemeLight: "github-light", CronTicker: true, EasterEggs: true})
	want := "theme: catppuccin-mocha\ntheme_dark: catppuccin-mocha\ntheme_light: github-light\n"
	if got != want {
		t.Errorf("serialize = %q, want %q", got, want)
	}
}

func TestParseOptionalSettings(t *testing.T) {
	cases := []struct {
		name  string
		input string
		check func(*testing.T, Settings)
	}{
		{
			name:  "server colors",
			input: "theme: system\nserver_colors:\n  default: 4\n  dev: \"10\"\n  blend: \"1+3\"\n  bad: \"99\"\n",
			check: func(t *testing.T, s Settings) {
				if len(s.ServerColors) != 3 {
					t.Fatalf("expected 3 valid server colors, got %d: %v", len(s.ServerColors), s.ServerColors)
				}
				for key, want := range map[string]string{"default": "4", "dev": "10", "blend": "1+3"} {
					if got := s.ServerColors[key]; got != want {
						t.Errorf("ServerColors[%s] = %q, want %q", key, got, want)
					}
				}
				if _, ok := s.ServerColors["bad"]; ok {
					t.Errorf("malformed value 99 should have been dropped, got %q", s.ServerColors["bad"])
				}
			},
		},
		{
			name:  "legacy integer server colors",
			input: "server_colors:\n  default: 4\n  dev: 10\n",
			check: func(t *testing.T, s Settings) {
				if s.ServerColors["default"] != "4" || s.ServerColors["dev"] != "10" {
					t.Errorf("legacy integer server colors did not load: %v", s.ServerColors)
				}
			},
		},
		{
			name:  "server flairs",
			input: "theme: system\nserver_flairs:\n  default: \"nyan\"\n  dev: cube\n  bad: \"bogus\"\n  empty: \"\"\n",
			check: func(t *testing.T, s Settings) {
				if len(s.ServerFlairs) != 2 {
					t.Fatalf("expected 2 valid server flairs, got %d: %v", len(s.ServerFlairs), s.ServerFlairs)
				}
				if s.ServerFlairs["default"] != "nyan" || s.ServerFlairs["dev"] != "cube" {
					t.Errorf("ServerFlairs = %v, want default=nyan and dev=cube", s.ServerFlairs)
				}
				if _, ok := s.ServerFlairs["bad"]; ok {
					t.Errorf("unknown token bogus should have been dropped, got %q", s.ServerFlairs["bad"])
				}
			},
		},
		{
			name:  "board order",
			input: "theme: system\nboard_order:\n  - \"reviews\"\n  - \"deploys\"\n  - scratch\n",
			check: func(t *testing.T, s Settings) {
				want := []string{"reviews", "deploys", "scratch"}
				if !reflect.DeepEqual(s.BoardOrder, want) {
					t.Errorf("BoardOrder = %v, want %v", s.BoardOrder, want)
				}
			},
		},
		{
			name:  "missing board order",
			input: "theme: dracula\nserver_colors:\n  default: 4\n",
			check: func(t *testing.T, s Settings) {
				if s.BoardOrder != nil {
					t.Errorf("BoardOrder = %v, want nil", s.BoardOrder)
				}
			},
		},
		{
			name:  "riff presets keep empty values and skip malformed names",
			input: "riff_presets:\n  review: \"/code-review high\"\n  blank: \"\"\n  \"bad name\": \"/x\"\n  -bad: \"/y\"\n",
			check: func(t *testing.T, s Settings) {
				want := map[string]string{"review": "/code-review high", "blank": ""}
				if !reflect.DeepEqual(s.RiffPresets, want) {
					t.Errorf("RiffPresets = %v, want %v (empty value survives; malformed names skipped)", s.RiffPresets, want)
				}
			},
		},
		{
			name:  "riff preset values are trimmed and quote-carrying values dropped",
			input: "riff_presets:\n  review: \"  /code-review high  \"\n  quoted: \"/x \"y\"\"\n",
			check: func(t *testing.T, s Settings) {
				want := map[string]string{"review": "/code-review high"}
				if !reflect.DeepEqual(s.RiffPresets, want) {
					t.Errorf("RiffPresets = %v, want %v (inner whitespace trimmed; quote-carrying value dropped)", s.RiffPresets, want)
				}
			},
		},
		{
			name:  "missing riff presets",
			input: "theme: dracula\n",
			check: func(t *testing.T, s Settings) {
				if s.RiffPresets != nil {
					t.Errorf("RiffPresets = %v, want nil", s.RiffPresets)
				}
			},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			tc.check(t, parse(tc.input))
		})
	}

	t.Run("instance color vocabulary", func(t *testing.T) {
		for _, tc := range []struct {
			input string
			want  string
		}{
			{"instance_color: \"4\"\n", "4"},
			{"instance_color: \"1+3\"\n", "1+3"},
			{"instance_color: 4\n", "4"},
			{"instance_color: \"01\"\n", "1"},
			{"instance_color: \"99\"\n", ""},
			{"instance_color: \"1+2+3\"\n", ""},
			{"theme: system\n", ""},
		} {
			if got := parse(tc.input).InstanceColor; got != tc.want {
				t.Errorf("parse(%q).InstanceColor = %q, want %q", tc.input, got, tc.want)
			}
		}
	})

	t.Run("ssh host and instance name", func(t *testing.T) {
		for _, tc := range []struct {
			input        string
			wantSSH      string
			wantInstance string
		}{
			{"ssh_host: \"devbox\"\n", "devbox", ""},
			{"ssh_host: devbox\n", "devbox", ""},
			{"ssh_host: \"user@host\"\n", "user@host", ""},
			{"instance_name: \"my-box\"\n", "", "my-box"},
			{"instance_name: \"dev mini\"\n", "", "dev mini"},
			{"ssh_host: \"devbox\"\ninstance_name: \"my-box\"\n", "devbox", "my-box"},
			{"theme: system\n", "", ""},
		} {
			s := parse(tc.input)
			if s.SSHHost != tc.wantSSH {
				t.Errorf("parse(%q).SSHHost = %q, want %q", tc.input, s.SSHHost, tc.wantSSH)
			}
			if s.InstanceName != tc.wantInstance {
				t.Errorf("parse(%q).InstanceName = %q, want %q", tc.input, s.InstanceName, tc.wantInstance)
			}
		}
	})

	t.Run("tmux config and log level", func(t *testing.T) {
		for _, tc := range []struct {
			input        string
			wantTmuxConf string
			wantLogLevel string
		}{
			{"tmux_conf: \"/my/tmux.conf\"\n", "/my/tmux.conf", "info"},
			{"tmux_conf: /my/tmux.conf\n", "/my/tmux.conf", "info"},
			{"log_level: debug\n", "", "debug"},
			{"log_level: \"debug\"\n", "", "debug"},
			{"log_level: info\n", "", "info"},
			{"log_level: trace\n", "", "info"},
			{"log_level: \"\"\n", "", "info"},
			{"theme: system\n", "", "info"},
		} {
			s := parse(tc.input)
			if s.TmuxConf != tc.wantTmuxConf {
				t.Errorf("parse(%q).TmuxConf = %q, want %q", tc.input, s.TmuxConf, tc.wantTmuxConf)
			}
			if s.LogLevel != tc.wantLogLevel {
				t.Errorf("parse(%q).LogLevel = %q, want %q", tc.input, s.LogLevel, tc.wantLogLevel)
			}
		}
	})
}

func TestSerializeOptionalSettings(t *testing.T) {
	base := Settings{Theme: "system", ThemeDark: "default-dark", ThemeLight: "default-light", CronTicker: true, EasterEggs: true}
	cases := []struct {
		name   string
		mutate func(*Settings)
		want   string
	}{
		{
			name: "server colors",
			mutate: func(s *Settings) {
				s.ServerColors = map[string]string{"default": "4", "dev": "1+3"}
			},
			want: "theme: system\ntheme_dark: default-dark\ntheme_light: default-light\nserver_colors:\n  default: \"4\"\n  dev: \"1+3\"\n",
		},
		{
			name: "server flairs",
			mutate: func(s *Settings) {
				s.ServerFlairs = map[string]string{"default": "nyan", "dev": "cube"}
			},
			want: "theme: system\ntheme_dark: default-dark\ntheme_light: default-light\nserver_flairs:\n  default: \"nyan\"\n  dev: \"cube\"\n",
		},
		{
			name: "riff presets serialize sorted and quoted, after board_order",
			mutate: func(s *Settings) {
				s.BoardOrder = []string{"reviews"}
				s.RiffPresets = map[string]string{"review": "/code-review high", "blank": ""}
			},
			want: "theme: system\ntheme_dark: default-dark\ntheme_light: default-light\nboard_order:\n  - \"reviews\"\nriff_presets:\n  blank: \"\"\n  review: \"/code-review high\"\n",
		},
		{
			name:   "board order",
			mutate: func(s *Settings) { s.BoardOrder = []string{"reviews", "deploys"} },
			want:   "theme: system\ntheme_dark: default-dark\ntheme_light: default-light\nboard_order:\n  - \"reviews\"\n  - \"deploys\"\n",
		},
		{
			name:   "instance color",
			mutate: func(s *Settings) { s.InstanceColor = "1+3" },
			want:   "theme: system\ntheme_dark: default-dark\ntheme_light: default-light\ninstance_color: \"1+3\"\n",
		},
		{
			name: "ssh host and instance name",
			mutate: func(s *Settings) {
				s.InstanceColor = "4"
				s.SSHHost = "devbox"
				s.InstanceName = "my-box"
			},
			want: "theme: system\ntheme_dark: default-dark\ntheme_light: default-light\ninstance_color: \"4\"\nssh_host: \"devbox\"\ninstance_name: \"my-box\"\n",
		},
		{
			name: "tmux config and log level",
			mutate: func(s *Settings) {
				s.AutoName = true
				s.TmuxConf = "/my/tmux.conf"
				s.LogLevel = "debug"
				s.ServerColors = map[string]string{"default": "4"}
			},
			want: "theme: system\ntheme_dark: default-dark\ntheme_light: default-light\nauto_name: true\ntmux_conf: \"/my/tmux.conf\"\nlog_level: debug\nserver_colors:\n  default: \"4\"\n",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			s := base
			tc.mutate(&s)
			if got := serialize(s); got != tc.want {
				t.Errorf("serialize = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestSerializeEmptyOptionalSettingsIsByteIdentical(t *testing.T) {
	got := serialize(Settings{Theme: "system", ThemeDark: "default-dark", ThemeLight: "default-light", CronTicker: true, EasterEggs: true, LogLevel: "info"})
	want := "theme: system\ntheme_dark: default-dark\ntheme_light: default-light\n"
	if got != want {
		t.Errorf("serialize with optional defaults = %q, want %q", got, want)
	}
}

func TestOptionalSettingRoundTrips(t *testing.T) {
	type roundTripFixture func(*testing.T, *registryEntry)

	registryValueFixture := func(firstPatch string, firstWant any, secondPatch string, secondWant, clearedWant any) roundTripFixture {
		return func(t *testing.T, entry *registryEntry) {
			s := Default()
			if got := entry.read(&s); !reflect.DeepEqual(got, clearedWant) {
				t.Errorf("read unset = %#v, want %#v", got, clearedWant)
			}

			assertRoundTrip := func(label string, want any) {
				t.Helper()
				s = parse(serialize(s))
				if got := entry.read(&s); !reflect.DeepEqual(got, want) {
					t.Errorf("read %s = %#v, want %#v", label, got, want)
				}
			}

			if err := entry.apply(&s, json.RawMessage(firstPatch)); err != nil {
				t.Fatalf("apply first value: %v", err)
			}
			assertRoundTrip("after first value", firstWant)

			if err := entry.apply(&s, json.RawMessage(secondPatch)); err != nil {
				t.Fatalf("apply second value: %v", err)
			}
			assertRoundTrip("after second value", secondWant)

			if err := entry.apply(&s, json.RawMessage(`null`)); err != nil {
				t.Fatalf("clear: %v", err)
			}
			assertRoundTrip("after clear", clearedWant)
		}
	}

	stringValueFixture := func(firstValue, secondValue string, set func(*string) error, get func() *string) roundTripFixture {
		return func(t *testing.T, _ *registryEntry) {
			t.Setenv("HOME", t.TempDir())
			if got := get(); got != nil {
				t.Errorf("get unset = %v, want nil", *got)
			}
			value := firstValue
			if err := set(&value); err != nil {
				t.Fatalf("set: %v", err)
			}
			if got := get(); got == nil || *got != value {
				t.Errorf("get = %v, want %q", got, value)
			}
			value = secondValue
			if err := set(&value); err != nil {
				t.Fatalf("overwrite: %v", err)
			}
			if got := get(); got == nil || *got != value {
				t.Errorf("get after overwrite = %v, want %q", got, value)
			}
			if err := set(nil); err != nil {
				t.Fatalf("clear: %v", err)
			}
			if got := get(); got != nil {
				t.Errorf("get after clear = %v, want nil", *got)
			}
		}
	}

	fixtures := map[string]roundTripFixture{
		"theme":          registryValueFixture(`"dark"`, ptr("dark"), `"light"`, ptr("light"), ptr("system")),
		"theme_dark":     registryValueFixture(`"dracula"`, ptr("dracula"), `"nord"`, ptr("nord"), ptr("default-dark")),
		"theme_light":    registryValueFixture(`"solarized-light"`, ptr("solarized-light"), `"paper"`, ptr("paper"), ptr("default-light")),
		"instance_color": stringValueFixture("5", "1+3", SetInstanceColor, GetInstanceColor),
		"ssh_host":       stringValueFixture("devbox", "user@host", SetSSHHost, GetSSHHost),
		"port":           registryValueFixture(`4000`, 4000, `3000`, 3000, nil),
		"instance_name":  stringValueFixture("my-box", "dev mini", SetInstanceName, GetInstanceName),
		"auto_name":      registryValueFixture(`true`, true, `false`, false, false),
		"cron_ticker":    registryValueFixture(`false`, false, `true`, true, true),
		"easter_eggs":    registryValueFixture(`false`, false, `true`, true, true),
		"gui.enabled":    registryValueFixture(`true`, true, `false`, false, false),
		"gui.wm":         registryValueFixture(`"openbox"`, "openbox", `"xfwm4"`, "xfwm4", ""),
		"gui.geometry":   registryValueFixture(`"auto"`, "auto", `"1600x900"`, "1600x900", "1920x1080"),
		"tmux_conf":      registryValueFixture(`"/my/tmux.conf"`, ptr("/my/tmux.conf"), `"/other/tmux.conf"`, ptr("/other/tmux.conf"), (*string)(nil)),
		"log_level":      registryValueFixture(`"debug"`, ptr("debug"), `"info"`, ptr("info"), ptr("info")),
		"server_colors": stringValueFixture("6", "1+3", func(v *string) error {
			return SetServerColor("default", v)
		}, func() *string { return GetServerColor("default") }),
		"server_flairs": stringValueFixture("cube", "warp", func(v *string) error {
			return SetServerFlair("default", v)
		}, func() *string { return GetServerFlair("default") }),
		// Map-kind entries merge per entry, so each patch asserts the merged map.
		"riff_presets": registryValueFixture(
			`{"review": "/code-review high"}`, map[string]string{"review": "/code-review high"},
			`{"blank": "/fab-discuss"}`, map[string]string{"review": "/code-review high", "blank": "/fab-discuss"},
			map[string]string(nil)),
		"board_order": func(t *testing.T, _ *registryEntry) {
			t.Setenv("HOME", t.TempDir())
			if got := GetBoardOrder(); got != nil {
				t.Errorf("GetBoardOrder unset = %v, want nil", got)
			}
			if err := SetBoardOrder([]string{"b", "a", "c"}); err != nil {
				t.Fatalf("SetBoardOrder: %v", err)
			}
			if got := GetBoardOrder(); !reflect.DeepEqual(got, []string{"b", "a", "c"}) {
				t.Errorf("GetBoardOrder = %v, want [b a c]", got)
			}
			if err := SetBoardOrder([]string{"a"}); err != nil {
				t.Fatalf("SetBoardOrder rewrite: %v", err)
			}
			if got := GetBoardOrder(); !reflect.DeepEqual(got, []string{"a"}) {
				t.Errorf("GetBoardOrder after rewrite = %v, want [a]", got)
			}
			if err := SetBoardOrder(nil); err != nil {
				t.Fatalf("SetBoardOrder nil: %v", err)
			}
			if got := GetBoardOrder(); got != nil {
				t.Errorf("GetBoardOrder after clear = %v, want nil", got)
			}
		},
	}

	for i := range registry {
		entry := &registry[i]
		fixture, ok := fixtures[entry.key]
		if !ok {
			t.Errorf("registry key %q has no round-trip fixture", entry.key)
			continue
		}
		t.Run(entry.key, func(t *testing.T) {
			fixture(t, entry)
		})
	}
	for key := range fixtures {
		if findEntry(key) == nil {
			t.Errorf("round-trip fixture %q has no registry entry", key)
		}
	}

	t.Run("missing server color key", func(t *testing.T) {
		t.Setenv("HOME", t.TempDir())
		if got := GetServerColor("nonexistent"); got != nil {
			t.Errorf("GetServerColor(nonexistent) = %v, want nil", got)
		}
	})

	t.Run("server flair clear removes section", func(t *testing.T) {
		tmp := t.TempDir()
		t.Setenv("HOME", tmp)
		flair := "cube"
		if err := SetServerFlair("default", &flair); err != nil {
			t.Fatalf("SetServerFlair: %v", err)
		}
		if err := SetServerFlair("default", nil); err != nil {
			t.Fatalf("SetServerFlair clear: %v", err)
		}
		data, err := os.ReadFile(filepath.Join(tmp, ".config", "hexokit", "config.yaml"))
		if err != nil {
			t.Fatalf("ReadFile: %v", err)
		}
		if strings.Contains(string(data), "server_flairs") {
			t.Errorf("cleared map left a server_flairs heading in the file:\n%s", data)
		}
	})

}

func TestOptionalSettingsCoexist(t *testing.T) {
	t.Setenv("HOME", t.TempDir())

	serverColor := "4"
	instanceColor := "2"
	host := "devbox"
	name := "my-box"
	for label, set := range map[string]func() error{
		"server color":   func() error { return SetServerColor("default", &serverColor) },
		"instance color": func() error { return SetInstanceColor(&instanceColor) },
		"ssh host":       func() error { return SetSSHHost(&host) },
		"instance name":  func() error { return SetInstanceName(&name) },
		"board order":    func() error { return SetBoardOrder([]string{"x", "y"}) },
	} {
		if err := set(); err != nil {
			t.Fatalf("%s: %v", label, err)
		}
	}

	loaded := Load()
	if loaded.ServerColors["default"] != "4" {
		t.Errorf("ServerColors[default] = %q, want 4", loaded.ServerColors["default"])
	}
	if loaded.InstanceColor != "2" {
		t.Errorf("InstanceColor = %q, want 2", loaded.InstanceColor)
	}
	if loaded.SSHHost != "devbox" {
		t.Errorf("SSHHost = %q, want devbox", loaded.SSHHost)
	}
	if loaded.InstanceName != "my-box" {
		t.Errorf("InstanceName = %q, want my-box", loaded.InstanceName)
	}
	if !reflect.DeepEqual(loaded.BoardOrder, []string{"x", "y"}) {
		t.Errorf("BoardOrder = %v, want [x y]", loaded.BoardOrder)
	}
}

func TestAutoName(t *testing.T) {
	t.Run("defaults off", func(t *testing.T) {
		if Default().AutoName {
			t.Error("Default().AutoName = true, want false")
		}
		if parse("theme: dark\n").AutoName {
			t.Error("AutoName = true for a file without the key, want false")
		}
	})

	t.Run("parses ParseBool values, tolerates garbage", func(t *testing.T) {
		for value, want := range map[string]bool{"true": true, "1": true, "TRUE": true, "false": false, "0": false, "yes-please": false, "\"true\"": true} {
			if got := parse("auto_name: " + value + "\n").AutoName; got != want {
				t.Errorf("parse auto_name: %s → %v, want %v", value, got, want)
			}
		}
	})

	t.Run("round-trips and is omitted when off", func(t *testing.T) {
		s := Default()
		s.AutoName = true
		if got := parse(serialize(s)); !got.AutoName {
			t.Error("AutoName lost in serialize/parse round-trip")
		}
		s.AutoName = false
		if out := serialize(s); strings.Contains(out, "auto_name") {
			t.Errorf("auto_name emitted for the off default — legacy files must serialize byte-identically:\n%s", out)
		}
	})
}

func TestCronTicker(t *testing.T) {
	t.Run("defaults on", func(t *testing.T) {
		if !Default().CronTicker {
			t.Error("Default().CronTicker = false, want true")
		}
		if !parse("theme: dark\n").CronTicker {
			t.Error("CronTicker = false for a file without the key, want true")
		}
	})

	t.Run("parses ParseBool values, tolerates garbage", func(t *testing.T) {
		for value, want := range map[string]bool{"true": true, "1": true, "false": false, "0": false, "\"false\"": false} {
			if got := parse("cron_ticker: " + value + "\n").CronTicker; got != want {
				t.Errorf("parse cron_ticker: %s → %v, want %v", value, got, want)
			}
		}
		// An unparseable value keeps the default (on) — the safe direction for
		// a scheduling substrate.
		if got := parse("cron_ticker: yes-please\n").CronTicker; !got {
			t.Error("parse cron_ticker: garbage → false, want true (default kept)")
		}
	})

	t.Run("round-trips and is omitted when on", func(t *testing.T) {
		s := Default()
		s.CronTicker = false
		if got := parse(serialize(s)); got.CronTicker {
			t.Error("CronTicker=false lost in serialize/parse round-trip")
		}
		s.CronTicker = true
		if out := serialize(s); strings.Contains(out, "cron_ticker") {
			t.Errorf("cron_ticker emitted for the on default — files without the key must serialize byte-identically:\n%s", out)
		}
	})
}

func TestEasterEggs(t *testing.T) {
	t.Run("defaults on", func(t *testing.T) {
		if !Default().EasterEggs {
			t.Error("Default().EasterEggs = false, want true")
		}
		if !parse("theme: dark\n").EasterEggs {
			t.Error("EasterEggs = false for a file without the key, want true")
		}
	})

	t.Run("parses ParseBool values, tolerates garbage", func(t *testing.T) {
		for value, want := range map[string]bool{"true": true, "1": true, "false": false, "0": false, "\"false\"": false} {
			if got := parse("easter_eggs: " + value + "\n").EasterEggs; got != want {
				t.Errorf("parse easter_eggs: %s → %v, want %v", value, got, want)
			}
		}
		// An unparseable value keeps the default (on) — the safe direction for
		// a cosmetic default-on feature.
		if got := parse("easter_eggs: yes-please\n").EasterEggs; !got {
			t.Error("parse easter_eggs: garbage → false, want true (default kept)")
		}
	})

	t.Run("round-trips and is omitted when on", func(t *testing.T) {
		s := Default()
		s.EasterEggs = false
		if got := parse(serialize(s)); got.EasterEggs {
			t.Error("EasterEggs=false lost in serialize/parse round-trip")
		}
		s.EasterEggs = true
		if out := serialize(s); strings.Contains(out, "easter_eggs") {
			t.Errorf("easter_eggs emitted for the on default — files without the key must serialize byte-identically:\n%s", out)
		}
	})
}

func TestGUIEnabled(t *testing.T) {
	t.Run("defaults off and is never on by default", func(t *testing.T) {
		if Default().GUIEnabled {
			t.Error("Default().GUIEnabled = true, want false")
		}
		t.Setenv(ConfigDirEnv, t.TempDir())
		if Load().GUIEnabled {
			t.Error("Load() on an empty config dir: GUIEnabled = true, want false")
		}
	})

	t.Run("parses ParseBool values, tolerates garbage", func(t *testing.T) {
		for value, want := range map[string]bool{"true": true, "1": true, "TRUE": true, "false": false, "0": false, "yes-please": false, "\"true\"": true} {
			if got := parse("gui.enabled: " + value + "\n").GUIEnabled; got != want {
				t.Errorf("parse gui.enabled: %s → %v, want %v", value, got, want)
			}
		}
	})

	t.Run("round-trips as a flat dotted line, omitted when off", func(t *testing.T) {
		s := Default()
		s.GUIEnabled = true
		out := serialize(s)
		if !strings.Contains(out, "gui.enabled: true\n") {
			t.Errorf("serialize(GUIEnabled=true) missing the flat dotted line:\n%s", out)
		}
		if got := parse(out); !got.GUIEnabled {
			t.Error("GUIEnabled lost in serialize/parse round-trip")
		}
		s.GUIEnabled = false
		if out := serialize(s); strings.Contains(out, "gui.enabled") {
			t.Errorf("gui.enabled emitted for the off default — files without the key must serialize byte-identically:\n%s", out)
		}
	})

	t.Run("off after on removes the line byte-identically", func(t *testing.T) {
		t.Setenv(ConfigDirEnv, t.TempDir())
		if err := Save(Default()); err != nil {
			t.Fatalf("Save baseline: %v", err)
		}
		p, err := configPath()
		if err != nil {
			t.Fatalf("configPath: %v", err)
		}
		before, err := os.ReadFile(p)
		if err != nil {
			t.Fatalf("ReadFile baseline: %v", err)
		}

		s := Load()
		s.GUIEnabled = true
		if err := Save(s); err != nil {
			t.Fatalf("Save on: %v", err)
		}
		data, err := os.ReadFile(p)
		if err != nil {
			t.Fatalf("ReadFile on: %v", err)
		}
		if got := strings.Count(string(data), "gui.enabled: true"); got != 1 {
			t.Errorf("on file contains %d gui.enabled lines, want exactly 1:\n%s", got, data)
		}
		if !Load().GUIEnabled {
			t.Error("Load() after Save(on): GUIEnabled = false, want true")
		}

		s = Load()
		s.GUIEnabled = false
		if err := Save(s); err != nil {
			t.Fatalf("Save off: %v", err)
		}
		after, err := os.ReadFile(p)
		if err != nil {
			t.Fatalf("ReadFile off: %v", err)
		}
		if string(after) != string(before) {
			t.Errorf("post-toggle file = %q, want byte-identical to pre-toggle %q", after, before)
		}
		if Load().GUIEnabled {
			t.Error("Load() after Save(off): GUIEnabled = true, want false")
		}
	})
}

func TestGUIWM(t *testing.T) {
	t.Run("round-trips as a quoted dotted line, omitted when empty", func(t *testing.T) {
		s := Default()
		if out := serialize(s); strings.Contains(out, "gui.wm") {
			t.Errorf("gui.wm emitted for the empty default — files without the key must serialize byte-identically:\n%s", out)
		}
		s.GUIWM = "openbox"
		out := serialize(s)
		if !strings.Contains(out, "gui.wm: \"openbox\"\n") {
			t.Errorf("serialize(GUIWM=openbox) missing the quoted dotted line:\n%s", out)
		}
		if got := parse(out); got.GUIWM != "openbox" {
			t.Errorf("GUIWM lost in serialize/parse round-trip: %q", got.GUIWM)
		}
	})

	t.Run("null unsets", func(t *testing.T) {
		entry := findEntry("gui.wm")
		if entry == nil {
			t.Fatal("no gui.wm registry entry")
		}
		s := Default()
		if err := entry.apply(&s, json.RawMessage(`"openbox"`)); err != nil {
			t.Fatalf("apply: %v", err)
		}
		if s.GUIWM != "openbox" {
			t.Errorf("GUIWM = %q after apply, want openbox", s.GUIWM)
		}
		if err := entry.apply(&s, json.RawMessage(`null`)); err != nil {
			t.Fatalf("apply null: %v", err)
		}
		if s.GUIWM != "" {
			t.Errorf("GUIWM = %q after null, want unset", s.GUIWM)
		}
	})
}

func TestGUIGeometry(t *testing.T) {
	t.Run("omitted at the default, reading back yields 1920x1080", func(t *testing.T) {
		s := Default()
		out := serialize(s)
		if strings.Contains(out, "gui.geometry") {
			t.Errorf("gui.geometry emitted at the default — files without the key must serialize byte-identically:\n%s", out)
		}
		if got := parse(out); got.GUIGeometry != "1920x1080" {
			t.Errorf("GUIGeometry after a default round-trip = %q, want %q", got.GUIGeometry, "1920x1080")
		}
	})

	t.Run("auto and a custom size round-trip as a quoted dotted line", func(t *testing.T) {
		for _, v := range []string{"auto", "1600x900"} {
			s := Default()
			s.GUIGeometry = v
			out := serialize(s)
			if !strings.Contains(out, "gui.geometry: \""+v+"\"\n") {
				t.Errorf("serialize(GUIGeometry=%q) missing the quoted dotted line:\n%s", v, out)
			}
			if got := parse(out); got.GUIGeometry != v {
				t.Errorf("GUIGeometry lost in serialize/parse round-trip: got %q, want %q", got.GUIGeometry, v)
			}
		}
	})

	t.Run("a value the validator rejects keeps the default on read", func(t *testing.T) {
		if got := parse("gui.geometry: \"bogus\"\n"); got.GUIGeometry != "1920x1080" {
			t.Errorf("GUIGeometry after a garbage line = %q, want %q", got.GUIGeometry, "1920x1080")
		}
	})

	t.Run("null restores the default", func(t *testing.T) {
		entry := findEntry("gui.geometry")
		if entry == nil {
			t.Fatal("no gui.geometry registry entry")
		}
		s := Default()
		if err := entry.apply(&s, json.RawMessage(`"auto"`)); err != nil {
			t.Fatalf("apply: %v", err)
		}
		if s.GUIGeometry != "auto" {
			t.Errorf("GUIGeometry = %q after apply, want auto", s.GUIGeometry)
		}
		if err := entry.apply(&s, json.RawMessage(`null`)); err != nil {
			t.Fatalf("apply null: %v", err)
		}
		if s.GUIGeometry != "1920x1080" {
			t.Errorf("GUIGeometry = %q after null, want 1920x1080", s.GUIGeometry)
		}
	})

	t.Run("invalid value rejected with the range message", func(t *testing.T) {
		entry := findEntry("gui.geometry")
		if entry == nil {
			t.Fatal("no gui.geometry registry entry")
		}
		s := Default()
		err := entry.apply(&s, json.RawMessage(`"100x100"`))
		if err == nil || err.Error() != "geometry 100x100 out of range (320–7680 per side)" {
			t.Fatalf("apply err = %v, want %q", err, "geometry 100x100 out of range (320–7680 per side)")
		}
		if s.GUIGeometry != "1920x1080" {
			t.Errorf("GUIGeometry mutated on rejection: %q", s.GUIGeometry)
		}
	})
}

// --- fixed config root (R1, R2) ---

func TestConfigRootIsFixedAndEnvImmune(t *testing.T) {
	tmp := t.TempDir()
	xdg := t.TempDir()
	t.Setenv("HOME", tmp)
	t.Setenv("XDG_CONFIG_HOME", xdg)
	// Hermetic against an ambient test-isolation override in the caller's env.
	t.Setenv(ConfigDirEnv, "")

	dir, err := Dir()
	if err != nil {
		t.Fatalf("Dir: %v", err)
	}
	if want := filepath.Join(tmp, ".config", "hexokit"); dir != want {
		t.Errorf("Dir() = %q, want %q (XDG_CONFIG_HOME must not move the root)", dir, want)
	}

	p, err := configPath()
	if err != nil {
		t.Fatalf("configPath: %v", err)
	}
	want := filepath.Join(tmp, ".config", "hexokit", "config.yaml")
	if p != want {
		t.Errorf("configPath() = %q, want %q", p, want)
	}
}

// TestConfigDirEnvOverride proves the RK_CONFIG_DIR test-isolation carve-out:
// whitespace-only is unset (production-identical fixed root), a set value is
// the config root verbatim and configPath follows it.
func TestConfigDirEnvOverride(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("HOME", tmp)

	t.Run("whitespace-only is unset", func(t *testing.T) {
		t.Setenv(ConfigDirEnv, "   ")
		dir, err := Dir()
		if err != nil {
			t.Fatalf("Dir: %v", err)
		}
		if want := filepath.Join(tmp, ".config", "hexokit"); dir != want {
			t.Errorf("Dir() = %q, want %q (whitespace-only override must behave as unset)", dir, want)
		}
	})

	t.Run("set moves root and configPath together", func(t *testing.T) {
		override := t.TempDir()
		t.Setenv(ConfigDirEnv, override)
		dir, err := Dir()
		if err != nil {
			t.Fatalf("Dir: %v", err)
		}
		if dir != override {
			t.Errorf("Dir() = %q, want the override %q verbatim", dir, override)
		}
		p, err := configPath()
		if err != nil {
			t.Fatalf("configPath: %v", err)
		}
		if want := filepath.Join(override, "config.yaml"); p != want {
			t.Errorf("configPath() = %q, want %q", p, want)
		}
	})
}

// TestConfigDirEnvOverrideSkipsLegacyPath proves the override suppresses both
// legacy ~/.rk/settings.yaml touchpoints: Load must not import the real
// $HOME's legacy settings into an isolated run, and Save must not
// breadcrumb-rename a file outside the isolated root.
func TestConfigDirEnvOverrideSkipsLegacyPath(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("HOME", tmp)
	legacy := filepath.Join(tmp, ".rk", "settings.yaml")
	if err := os.MkdirAll(filepath.Dir(legacy), 0755); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}
	if err := os.WriteFile(legacy, []byte("theme: dracula\n"), 0644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	t.Setenv(ConfigDirEnv, t.TempDir())

	if got := Load().Theme; got != "system" {
		t.Errorf("Load().Theme = %q, want default %q (legacy fallback must be skipped under the override)", got, "system")
	}
	if err := Save(Default()); err != nil {
		t.Fatalf("Save: %v", err)
	}
	if _, err := os.Stat(legacy); err != nil {
		t.Errorf("legacy settings.yaml must survive un-renamed under the override: %v", err)
	}
}

// TestConfigDirEnvOverrideSaveCreatesDir proves Save's existing MkdirAll path
// inherits the override: the relocated root is created on save exactly as the
// fixed root is, and the write lands there rather than under $HOME.
func TestConfigDirEnvOverrideSaveCreatesDir(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("HOME", tmp)
	override := filepath.Join(t.TempDir(), "nested", "config")
	t.Setenv(ConfigDirEnv, override)

	s := Default()
	s.InstanceName = "override-box"
	if err := Save(s); err != nil {
		t.Fatalf("Save: %v", err)
	}

	if _, err := os.Stat(filepath.Join(override, "config.yaml")); err != nil {
		t.Errorf("config.yaml not created under the override root: %v", err)
	}
	if got := Load().InstanceName; got != "override-box" {
		t.Errorf("Load().InstanceName = %q, want %q (load must read the override root)", got, "override-box")
	}
	if _, err := os.Stat(filepath.Join(tmp, ".config", "hexokit")); !os.IsNotExist(err) {
		t.Errorf("fixed $HOME root was touched despite the override (stat err = %v)", err)
	}
}

// --- registry round-trip (R8) ---

// TestRoundTripByteIdentical proves a current-format settings file parses and
// re-serializes to the exact same bytes.
func TestRoundTripByteIdentical(t *testing.T) {
	content := "theme: dracula\n" +
		"theme_dark: dracula\n" +
		"theme_light: solarized-light\n" +
		"instance_color: \"1+3\"\n" +
		"ssh_host: \"devbox\"\n" +
		"instance_name: \"my-box\"\n" +
		"auto_name: true\n" +
		"server_colors:\n  default: \"4\"\n  dev: \"1+3\"\n" +
		"server_flairs:\n  default: \"nyan\"\n  dev: \"cube\"\n" +
		"board_order:\n  - \"reviews\"\n  - \"deploys\"\n"
	if got := serialize(parse(content)); got != content {
		t.Errorf("round-trip not byte-identical:\n got: %q\nwant: %q", got, content)
	}
}

// --- migration 1: ~/.rk/settings.yaml → ~/.config/hexokit/config.yaml (R3, R4) ---

func TestLoadFallsBackToLegacyPath(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("HOME", tmp)
	t.Setenv(ConfigDirEnv, "")

	legacyDir := filepath.Join(tmp, ".rk")
	if err := os.MkdirAll(legacyDir, 0755); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}
	if err := os.WriteFile(filepath.Join(legacyDir, "settings.yaml"), []byte("theme: dracula\nssh_host: \"devbox\"\n"), 0644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}

	s := Load()
	if s.Theme != "dracula" {
		t.Errorf("Load (legacy fallback).Theme = %q, want %q", s.Theme, "dracula")
	}
	if s.SSHHost != "devbox" {
		t.Errorf("Load (legacy fallback).SSHHost = %q, want %q", s.SSHHost, "devbox")
	}
}

func TestSaveMigratesAndRenamesLegacyFile(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("HOME", tmp)
	t.Setenv(ConfigDirEnv, "")

	legacy := filepath.Join(tmp, ".rk", "settings.yaml")
	if err := os.MkdirAll(filepath.Dir(legacy), 0755); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}
	legacyContent := "theme: dracula\nssh_host: \"devbox\"\n"
	if err := os.WriteFile(legacy, []byte(legacyContent), 0644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}

	// Load picks up legacy values via fallback; saving the merged state must
	// land at the new path and breadcrumb-rename the old file.
	s := Load()
	s.Theme = "nord"
	if err := Save(s); err != nil {
		t.Fatalf("Save: %v", err)
	}

	data, err := os.ReadFile(filepath.Join(tmp, ".config", "hexokit", "config.yaml"))
	if err != nil {
		t.Fatalf("ReadFile new path: %v", err)
	}
	want := "theme: nord\ntheme_dark: default-dark\ntheme_light: default-light\nssh_host: \"devbox\"\n"
	if got := string(data); got != want {
		t.Errorf("new file content = %q, want %q (merged state)", got, want)
	}

	if _, err := os.Stat(legacy); !os.IsNotExist(err) {
		t.Error("legacy settings.yaml should be gone after migration")
	}
	breadcrumb, err := os.ReadFile(legacy + ".migrated")
	if err != nil {
		t.Fatalf("ReadFile breadcrumb: %v", err)
	}
	if string(breadcrumb) != legacyContent {
		t.Errorf("breadcrumb content = %q, want original %q", breadcrumb, legacyContent)
	}
}

func TestLoadNewPathWinsWhenBothExist(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("HOME", tmp)
	t.Setenv(ConfigDirEnv, "")

	legacyDir := filepath.Join(tmp, ".rk")
	if err := os.MkdirAll(legacyDir, 0755); err != nil {
		t.Fatalf("MkdirAll legacy: %v", err)
	}
	if err := os.WriteFile(filepath.Join(legacyDir, "settings.yaml"), []byte("theme: dracula\n"), 0644); err != nil {
		t.Fatalf("WriteFile legacy: %v", err)
	}
	newPath := filepath.Join(tmp, ".config", "hexokit", "config.yaml")
	if err := os.MkdirAll(filepath.Dir(newPath), 0755); err != nil {
		t.Fatalf("MkdirAll new: %v", err)
	}
	if err := os.WriteFile(newPath, []byte("theme: nord\n"), 0644); err != nil {
		t.Fatalf("WriteFile new: %v", err)
	}

	if s := Load(); s.Theme != "nord" {
		t.Errorf("Load (both exist).Theme = %q, want %q (new path wins)", s.Theme, "nord")
	}
}

func TestLoadBothAbsentReturnsDefaults(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("HOME", tmp)

	s := Load()
	want := Default()
	if !reflect.DeepEqual(s, want) {
		t.Errorf("Load (both absent) = %+v, want defaults %+v", s, want)
	}
}

func TestSaveWithoutLegacyFileSucceeds(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("HOME", tmp)

	// No legacy file — the breadcrumb rename must be a silent no-op.
	if err := Save(Default()); err != nil {
		t.Fatalf("Save: %v", err)
	}
	if _, err := os.Stat(filepath.Join(tmp, ".config", "hexokit", "config.yaml")); err != nil {
		t.Fatalf("new path not written: %v", err)
	}
}

func TestStampUnchangedFileIsStable(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("HOME", tmp)

	if got := Stamp(); got != "" {
		t.Errorf("Stamp (no file) = %q, want the stable empty fingerprint", got)
	}
	if err := Save(Default()); err != nil {
		t.Fatalf("Save: %v", err)
	}
	first := Stamp()
	if first == "" {
		t.Fatal("Stamp after Save must be non-empty")
	}
	if got := Stamp(); got != first {
		t.Errorf("Stamp on an unchanged file = %q, want %q", got, first)
	}
}

func TestStampChangesOnSave(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("HOME", tmp)

	if err := Save(Default()); err != nil {
		t.Fatalf("Save: %v", err)
	}
	before := Stamp()
	// Rewrite with a different size so the fingerprint moves even inside one
	// mtime tick.
	s := Default()
	s.InstanceName = "renamed-box"
	if err := Save(s); err != nil {
		t.Fatalf("Save: %v", err)
	}
	if got := Stamp(); got == before {
		t.Errorf("Stamp after a re-Save = %q, unchanged from %q", got, before)
	}
}

func TestStampLegacyFallback(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("HOME", tmp)

	// Absent primary + present legacy → the stamp mirrors Load's fallback.
	legacy := filepath.Join(tmp, ".rk", "settings.yaml")
	if err := os.MkdirAll(filepath.Dir(legacy), 0755); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}
	if err := os.WriteFile(legacy, []byte("theme: dracula\n"), 0644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	stamp := Stamp()
	if stamp == "" {
		t.Fatal("Stamp with only a legacy file must be non-empty")
	}
	if !strings.Contains(stamp, legacy) {
		t.Errorf("Stamp = %q, want a fingerprint of the legacy path %q", stamp, legacy)
	}
}

func TestStampConfigDirOverrideSkipsLegacy(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("HOME", tmp)

	legacy := filepath.Join(tmp, ".rk", "settings.yaml")
	if err := os.MkdirAll(filepath.Dir(legacy), 0755); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}
	if err := os.WriteFile(legacy, []byte("theme: dracula\n"), 0644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	t.Setenv(ConfigDirEnv, t.TempDir())

	if got := Stamp(); got != "" {
		t.Errorf("Stamp under the override with an absent primary = %q, want the empty fingerprint (no legacy fallback)", got)
	}
}

func TestStampUnreadablePrimaryFallsBackLikeLoad(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("HOME", tmp)

	// A directory where config.yaml should be: os.Stat succeeds but ReadFile
	// cannot — Load falls back to the legacy file, and Stamp must follow it
	// to the same source instead of fingerprinting the unreadable primary.
	primary, err := configPath()
	if err != nil {
		t.Fatalf("configPath: %v", err)
	}
	if err := os.MkdirAll(primary, 0755); err != nil {
		t.Fatalf("MkdirAll(primary as dir): %v", err)
	}
	legacy := filepath.Join(tmp, ".rk", "settings.yaml")
	if err := os.MkdirAll(filepath.Dir(legacy), 0755); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}
	if err := os.WriteFile(legacy, []byte("theme: dracula\n"), 0644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	if got := Load().Theme; got != "dracula" {
		t.Fatalf("Load with a directory-shaped primary = theme %q, want the legacy file's dracula", got)
	}
	stamp := Stamp()
	if !strings.Contains(stamp, legacy) {
		t.Errorf("Stamp = %q, want a fingerprint of the legacy path %q (the source Load read)", stamp, legacy)
	}
	if strings.Contains(stamp, primary+":") {
		t.Errorf("Stamp = %q fingerprints the unreadable primary %q", stamp, primary)
	}
}

// TestPortParse pins the port key's tolerant read: valid ports (bare or
// quoted) set Port; anything else — out of range, non-numeric, empty — leaves
// it unset (0) and never errors.
func TestPortParse(t *testing.T) {
	cases := []struct {
		line string
		want int
	}{
		{"port: 4000", 4000},
		{"port: \"4000\"", 4000},
		{"port:   4000  ", 4000},
		{"port: 1", 1},
		{"port: 65535", 65535},
		{"port: 0", 0},
		{"port: -1", 0},
		{"port: 65536", 0},
		{"port: 70000", 0},
		{"port: abc", 0},
		{"port: \"abc\"", 0},
		{"port: \"\"", 0},
		{"port:", 0},
	}
	for _, c := range cases {
		if s := parse(c.line + "\n"); s.Port != c.want {
			t.Errorf("parse(%q): Port = %d, want %d", c.line, s.Port, c.want)
		}
	}
}

// TestPortSerialize pins serialize-when-set: an explicitly set port emits a
// line even when it equals the code default (the key is a pin — a whole-file
// Save must not drop it); unset emits nothing, so an untouched file
// round-trips byte-identically.
func TestPortSerialize(t *testing.T) {
	if got := serialize(Default()); strings.Contains(got, "port:") {
		t.Errorf("serialize(Default()) = %q, want no port line", got)
	}
	for _, p := range []int{portpolicy.DaemonDefault, 4000} {
		s := Default()
		s.Port = p
		want := "port: " + strconv.Itoa(p) + "\n"
		if got := serialize(s); !strings.Contains(got, want) {
			t.Errorf("serialize(Port=%d) = %q, want it to contain %q", p, got, want)
		}
	}
}

// TestPortPinSurvivesSaveLoad proves the pin contract end to end: `port: 3000`
// (equal to the default) survives a Load → Save rewrite, and re-loads as 3000.
func TestPortPinSurvivesSaveLoad(t *testing.T) {
	t.Setenv(ConfigDirEnv, t.TempDir())

	s := Default()
	s.Port = portpolicy.DaemonDefault
	if err := Save(s); err != nil {
		t.Fatalf("Save: %v", err)
	}
	if got := Load(); got.Port != portpolicy.DaemonDefault {
		t.Fatalf("Load().Port = %d, want %d", got.Port, portpolicy.DaemonDefault)
	}
	if err := Save(Load()); err != nil {
		t.Fatalf("second Save: %v", err)
	}
	p, err := configPath()
	if err != nil {
		t.Fatalf("configPath: %v", err)
	}
	data, err := os.ReadFile(p)
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}
	if !strings.Contains(string(data), "port: "+strconv.Itoa(portpolicy.DaemonDefault)+"\n") {
		t.Errorf("saved file = %q, want it to keep the port: %d pin", data, portpolicy.DaemonDefault)
	}
}

// TestPortReadValue pins the GET shape: null when unset, the JSON number when
// set.
func TestPortReadValue(t *testing.T) {
	s := Default()
	got, ok := ReadValue(&s, "port")
	if !ok {
		t.Fatal("ReadValue(port): ok = false, want true")
	}
	if got != nil {
		t.Errorf("ReadValue(port) unset = %#v, want nil (JSON null)", got)
	}

	s.Port = 4000
	got, _ = ReadValue(&s, "port")
	if got != 4000 {
		t.Errorf("ReadValue(port) set = %#v, want 4000", got)
	}
	data, err := json.Marshal(got)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if string(data) != "4000" {
		t.Errorf("marshaled port = %s, want 4000 (a JSON number)", data)
	}
}

// TestPortApplyValue pins the strict write: JSON integers in range set, null
// unsets; strings, out-of-range, fractional, and bool values are rejected
// without mutation.
func TestPortApplyValue(t *testing.T) {
	s := Default()
	if err := ApplyValue(&s, "port", json.RawMessage(`4000`)); err != nil {
		t.Fatalf("apply port 4000: %v", err)
	}
	if s.Port != 4000 {
		t.Errorf("Port = %d, want 4000", s.Port)
	}
	if err := ApplyValue(&s, "port", json.RawMessage(`null`)); err != nil {
		t.Fatalf("apply port null: %v", err)
	}
	if s.Port != 0 {
		t.Errorf("Port after null = %d, want 0 (unset)", s.Port)
	}

	for _, patch := range []string{`0`, `70000`, `"4000"`, `4000.5`, `true`} {
		s := Default()
		s.Port = 4000
		if err := ApplyValue(&s, "port", json.RawMessage(patch)); err == nil {
			t.Errorf("ApplyValue(port, %s) succeeded, want error", patch)
		}
		if s.Port != 4000 {
			t.Errorf("ApplyValue(port, %s) mutated Port to %d, want unchanged 4000", patch, s.Port)
		}
	}
}

// --- config-home dual-read (R2) ---

// TestLegacyConfigDirDualRead proves the pre-migration window: when only the
// legacy ~/.config/run-kit dir exists, Dir resolves to it, Load reads it, and
// Save writes back to it — no hexokit dir is created.
func TestLegacyConfigDirDualRead(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("HOME", tmp)
	t.Setenv(ConfigDirEnv, "")

	legacyDir := filepath.Join(tmp, ".config", "run-kit")
	if err := os.MkdirAll(legacyDir, 0755); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}
	legacyFile := filepath.Join(legacyDir, "config.yaml")
	if err := os.WriteFile(legacyFile, []byte("theme: dracula\n"), 0644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}

	dir, err := Dir()
	if err != nil {
		t.Fatalf("Dir: %v", err)
	}
	if dir != legacyDir {
		t.Errorf("Dir() = %q, want the legacy dir %q", dir, legacyDir)
	}
	if got := Load().Theme; got != "dracula" {
		t.Errorf("Load().Theme = %q, want %q (read from the legacy file)", got, "dracula")
	}

	s := Load()
	s.Theme = "nord"
	if err := Save(s); err != nil {
		t.Fatalf("Save: %v", err)
	}
	data, err := os.ReadFile(legacyFile)
	if err != nil {
		t.Fatalf("ReadFile legacy: %v", err)
	}
	if !strings.Contains(string(data), "theme: nord\n") {
		t.Errorf("legacy file after Save = %q, want the write to land there", data)
	}
	if _, err := os.Stat(filepath.Join(tmp, ".config", "hexokit")); !os.IsNotExist(err) {
		t.Errorf("the hexokit dir was created while the legacy home was active (stat err = %v)", err)
	}
}

// TestNewConfigDirWinsOverLegacy: once both homes exist (migrated), the new
// dir is authoritative.
func TestNewConfigDirWinsOverLegacy(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("HOME", tmp)
	t.Setenv(ConfigDirEnv, "")

	legacyDir := filepath.Join(tmp, ".config", "run-kit")
	newDir := filepath.Join(tmp, ".config", "hexokit")
	for _, d := range []string{legacyDir, newDir} {
		if err := os.MkdirAll(d, 0755); err != nil {
			t.Fatalf("MkdirAll %s: %v", d, err)
		}
	}
	if err := os.WriteFile(filepath.Join(legacyDir, "config.yaml"), []byte("theme: dracula\n"), 0644); err != nil {
		t.Fatalf("WriteFile legacy: %v", err)
	}
	if err := os.WriteFile(filepath.Join(newDir, "config.yaml"), []byte("theme: nord\n"), 0644); err != nil {
		t.Fatalf("WriteFile new: %v", err)
	}

	if dir, err := Dir(); err != nil || dir != newDir {
		t.Errorf("Dir() = %q, %v — want the new dir %q", dir, err, newDir)
	}
	if got := Load().Theme; got != "nord" {
		t.Errorf("Load().Theme = %q, want %q (the new home wins)", got, "nord")
	}
}

// --- port pin comment round-trip (R7) ---

// TestPortPinCommentParse pins detection of the exact marker line: only the
// verbatim comment sets PortPinNote — other comments and near-misses do not.
func TestPortPinCommentParse(t *testing.T) {
	s := parse(PortPinComment + "\nport: 3000\n")
	if !s.PortPinNote {
		t.Error("PortPinNote = false, want true for the exact pin comment")
	}
	if s.Port != 3000 {
		t.Errorf("Port = %d, want 3000", s.Port)
	}

	for _, input := range []string{
		"# some other comment\nport: 3000\n",
		PortPinComment + " (edited)\nport: 3000\n",
		"port: 3000\n",
	} {
		if s := parse(input); s.PortPinNote {
			t.Errorf("parse(%q): PortPinNote = true, want false", input)
		}
	}
}

// TestPortPinCommentSerialize pins the emit rule: the comment line goes
// directly above `port: N` when the note holds and a port is set; an unset
// port emits neither (no dangling comment), and a cleared note emits the bare
// key.
func TestPortPinCommentSerialize(t *testing.T) {
	s := Default()
	s.Port = 3000
	s.PortPinNote = true
	want := PortPinComment + "\nport: 3000\n"
	if got := serialize(s); !strings.Contains(got, want) {
		t.Errorf("serialize = %q, want it to contain %q", got, want)
	}

	s.Port = 0
	if got := serialize(s); strings.Contains(got, "port") {
		t.Errorf("serialize (Port unset) = %q, want no port line or comment", got)
	}

	s.Port = 3000
	s.PortPinNote = false
	got := serialize(s)
	if strings.Contains(got, PortPinComment) || !strings.Contains(got, "port: 3000\n") {
		t.Errorf("serialize (note cleared) = %q, want the bare port line", got)
	}
}

// TestPortPinCommentSurvivesUnrelatedSave proves the round-trip end to end: a
// Load → mutate-an-unrelated-key → Save cycle keeps the comment directly
// above the pinned port.
func TestPortPinCommentSurvivesUnrelatedSave(t *testing.T) {
	t.Setenv(ConfigDirEnv, t.TempDir())

	p, err := configPath()
	if err != nil {
		t.Fatalf("configPath: %v", err)
	}
	content := "theme: dark\n" + PortPinComment + "\nport: 3000\n"
	if err := os.WriteFile(p, []byte(content), 0644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}

	s := Load()
	if !s.PortPinNote || s.Port != 3000 {
		t.Fatalf("Load: PortPinNote = %v, Port = %d — want true, 3000", s.PortPinNote, s.Port)
	}
	s.Theme = "nord"
	if err := Save(s); err != nil {
		t.Fatalf("Save: %v", err)
	}

	data, err := os.ReadFile(p)
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}
	if !strings.Contains(string(data), PortPinComment+"\nport: 3000\n") {
		t.Errorf("saved file = %q, want the pin comment directly above port: 3000", data)
	}
	if !strings.Contains(string(data), "theme: nord\n") {
		t.Errorf("saved file = %q, want the unrelated theme write", data)
	}
}

// TestPortPinCommentDroppedByRegistryPortWrite proves a registry write to the
// port key (set or null) drops the comment from the saved file.
func TestPortPinCommentDroppedByRegistryPortWrite(t *testing.T) {
	t.Setenv(ConfigDirEnv, t.TempDir())

	p, err := configPath()
	if err != nil {
		t.Fatalf("configPath: %v", err)
	}
	if err := os.WriteFile(p, []byte(PortPinComment+"\nport: 3000\n"), 0644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}

	s := Load()
	if err := ApplyValue(&s, "port", json.RawMessage(`6123`)); err != nil {
		t.Fatalf("ApplyValue port: %v", err)
	}
	if s.PortPinNote {
		t.Fatal("PortPinNote still set after a registry port write")
	}
	if err := Save(s); err != nil {
		t.Fatalf("Save: %v", err)
	}
	data, err := os.ReadFile(p)
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}
	if strings.Contains(string(data), PortPinComment) {
		t.Errorf("saved file = %q, want the pin comment gone after the port write", data)
	}
	if !strings.Contains(string(data), "port: 6123\n") {
		t.Errorf("saved file = %q, want port: 6123", data)
	}
}
