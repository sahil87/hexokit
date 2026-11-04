// Tests for the exported registry metadata (Registry/KeyInfo) and the generic
// JSON value read/apply surface (ReadValue/ApplyValue) that GET/POST
// /api/settings ride on.
package settings

import (
	"encoding/json"
	"reflect"
	"strconv"
	"strings"
	"testing"

	"rk/internal/portpolicy"
)

func TestRegistry_orderAndMetadata(t *testing.T) {
	infos := Registry()
	wantKeys := []string{
		"theme", "theme_dark", "theme_light", "instance_color", "ssh_host", "port",
		"instance_name", "auto_name", "cron_ticker", "easter_eggs", "gui.enabled", "gui.wm", "gui.geometry",
		"tmux_conf", "log_level", "server_colors", "server_flairs", "board_order", "riff_presets",
	}
	if len(infos) != len(wantKeys) {
		t.Fatalf("Registry() returned %d entries, want %d", len(infos), len(wantKeys))
	}
	for i, key := range wantKeys {
		if infos[i].Key != key {
			t.Errorf("Registry()[%d].Key = %q, want %q", i, infos[i].Key, key)
		}
	}
	// Metadata is verbatim from the registry table — spot-check one entry of
	// each kind plus the ui/live split.
	byKey := make(map[string]KeyInfo, len(infos))
	for _, info := range infos {
		byKey[info.Key] = info
	}
	checks := []struct {
		key, kind, def, category string
		ui, live                 bool
		options                  []string
	}{
		{"theme", "enum", "system", "appearance", true, true, []string{"system", "dark", "light"}},
		{"instance_color", "color", "", "appearance", true, true, nil},
		{"auto_name", "bool", "false", "behavior", true, true, nil},
		{"cron_ticker", "bool", "true", "behavior", true, true, nil},
		{"easter_eggs", "bool", "true", "behavior", true, true, nil},
		{"gui.enabled", "bool", "false", "behavior", true, true, nil},
		{"gui.wm", "string", "", "behavior", true, false, nil},
		{"gui.geometry", "string", "1920x1080", "behavior", true, true, nil},
		{"port", "port", strconv.Itoa(portpolicy.DaemonDefault), "connectivity", false, false, nil},
		{"log_level", "enum", "info", "advanced", true, false, []string{"info", "debug"}},
		{"server_colors", "map", "{}", "appearance", true, true, nil},
		{"server_flairs", "map", "{}", "appearance", true, true, nil},
		{"board_order", "list", "[]", "layout", true, true, nil},
		{"riff_presets", "map", `{"blank":"","discuss":"/fab-discuss","incognito":"/fab-incognito"}`, "behavior", false, true, nil},
	}
	for _, c := range checks {
		info, ok := byKey[c.key]
		if !ok {
			t.Errorf("Registry() missing key %q", c.key)
			continue
		}
		if info.Kind != c.kind || info.Default != c.def || info.Category != c.category || info.UI != c.ui || info.Live != c.live {
			t.Errorf("Registry()[%q] = %+v, want kind=%q default=%q category=%q ui=%v live=%v",
				c.key, info, c.kind, c.def, c.category, c.ui, c.live)
		}
		if info.Description == "" {
			t.Errorf("Registry()[%q].Description is empty", c.key)
		}
		if !reflect.DeepEqual(info.Options, c.options) {
			t.Errorf("Registry()[%q].Options = %v, want %v", c.key, info.Options, c.options)
		}
	}
}

func TestRegistry_optionsAreCopies(t *testing.T) {
	first := Registry()
	for i := range first {
		for j := range first[i].Options {
			first[i].Options[j] = "mutated"
		}
	}
	for _, info := range Registry() {
		for _, opt := range info.Options {
			if opt == "mutated" {
				t.Fatalf("Registry()[%q].Options aliases the package registry — caller mutation leaked", info.Key)
			}
		}
	}
}

func TestReadValue_defaultSettings(t *testing.T) {
	s := Default()
	cases := []struct {
		key  string
		want any
	}{
		{"theme", ptr("system")},
		{"theme_dark", ptr("default-dark")},
		{"theme_light", ptr("default-light")},
		{"instance_color", (*string)(nil)},
		{"ssh_host", (*string)(nil)},
		{"port", nil},
		{"instance_name", (*string)(nil)},
		{"auto_name", false},
		{"cron_ticker", true},
		{"easter_eggs", true},
		{"gui.enabled", false},
		{"gui.wm", ""},
		{"gui.geometry", "1920x1080"},
		{"tmux_conf", (*string)(nil)},
		{"log_level", ptr("info")},
		{"server_colors", map[string]string(nil)},
		{"server_flairs", map[string]string(nil)},
		{"board_order", []string(nil)},
		{"riff_presets", map[string]string(nil)},
	}
	for _, c := range cases {
		got, ok := ReadValue(&s, c.key)
		if !ok {
			t.Errorf("ReadValue(%q): ok = false, want true", c.key)
			continue
		}
		if !reflect.DeepEqual(got, c.want) {
			t.Errorf("ReadValue(%q) = %#v, want %#v", c.key, got, c.want)
		}
	}
}

func TestReadValue_nullForUnsetJSONRoundTrip(t *testing.T) {
	// An unset scalar marshals to JSON null — the null-means-unset contract
	// the API preserves from the folded per-key GETs.
	s := Default()
	got, _ := ReadValue(&s, "instance_color")
	data, err := json.Marshal(got)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if string(data) != "null" {
		t.Errorf("marshaled unset instance_color = %s, want null", data)
	}
}

func TestReadValue_unknownKey(t *testing.T) {
	s := Default()
	if _, ok := ReadValue(&s, "bogus"); ok {
		t.Error("ReadValue(bogus): ok = true, want false")
	}
}

func ptr(v string) *string { return &v }

func TestApplyValue_scalars(t *testing.T) {
	s := Default()

	if err := ApplyValue(&s, "theme", json.RawMessage(`"midnight"`)); err != nil {
		t.Fatalf("apply theme: %v", err)
	}
	if s.Theme != "midnight" {
		t.Errorf("theme = %q, want %q", s.Theme, "midnight")
	}

	// Null unsets to the registry default.
	if err := ApplyValue(&s, "theme", json.RawMessage(`null`)); err != nil {
		t.Fatalf("apply theme null: %v", err)
	}
	if s.Theme != "system" {
		t.Errorf("theme after null = %q, want %q", s.Theme, "system")
	}

	// Trim + validate path on ssh_host.
	if err := ApplyValue(&s, "ssh_host", json.RawMessage(`"  devbox  "`)); err != nil {
		t.Fatalf("apply ssh_host: %v", err)
	}
	if s.SSHHost != "devbox" {
		t.Errorf("ssh_host = %q, want %q", s.SSHHost, "devbox")
	}

	// Trimmed-to-empty is treated as null (unset).
	if err := ApplyValue(&s, "ssh_host", json.RawMessage(`"   "`)); err != nil {
		t.Fatalf("apply ssh_host empty: %v", err)
	}
	if s.SSHHost != "" {
		t.Errorf("ssh_host after empty = %q, want unset", s.SSHHost)
	}
	got, _ := ReadValue(&s, "ssh_host")
	if got != (*string)(nil) {
		t.Errorf("ReadValue(ssh_host) after empty = %#v, want nil", got)
	}

	// Bool.
	if err := ApplyValue(&s, "auto_name", json.RawMessage(`true`)); err != nil {
		t.Fatalf("apply auto_name: %v", err)
	}
	if !s.AutoName {
		t.Error("auto_name = false, want true")
	}
}

func TestApplyValue_perEntryMapMerge(t *testing.T) {
	s := Default()
	s.ServerColors = map[string]string{"dev": "4", "prod": "2"}

	err := ApplyValue(&s, "server_colors", json.RawMessage(`{"dev": null, "stage": "1+3"}`))
	if err != nil {
		t.Fatalf("apply server_colors: %v", err)
	}
	want := map[string]string{"prod": "2", "stage": "1+3"}
	if !reflect.DeepEqual(s.ServerColors, want) {
		t.Errorf("server_colors = %v, want %v", s.ServerColors, want)
	}

	// Top-level null clears the whole map.
	if err := ApplyValue(&s, "server_colors", json.RawMessage(`null`)); err != nil {
		t.Fatalf("apply server_colors null: %v", err)
	}
	if s.ServerColors != nil {
		t.Errorf("server_colors after top-level null = %v, want nil", s.ServerColors)
	}

	// Empty-string entry unsets, like null.
	s.ServerFlairs = map[string]string{"a": "rain", "b": "cube"}
	if err := ApplyValue(&s, "server_flairs", json.RawMessage(`{"a": ""}`)); err != nil {
		t.Fatalf("apply server_flairs empty: %v", err)
	}
	if !reflect.DeepEqual(s.ServerFlairs, map[string]string{"b": "cube"}) {
		t.Errorf("server_flairs = %v, want {b: cube}", s.ServerFlairs)
	}
}

func TestApplyValue_listReplace(t *testing.T) {
	s := Default()
	s.BoardOrder = []string{"deploys"}

	if err := ApplyValue(&s, "board_order", json.RawMessage(`["reviews","deploys"]`)); err != nil {
		t.Fatalf("apply board_order: %v", err)
	}
	if !reflect.DeepEqual(s.BoardOrder, []string{"reviews", "deploys"}) {
		t.Errorf("board_order = %v, want [reviews deploys]", s.BoardOrder)
	}

	for _, clear := range []string{`null`, `[]`} {
		if err := ApplyValue(&s, "board_order", json.RawMessage(clear)); err != nil {
			t.Fatalf("apply board_order %s: %v", clear, err)
		}
		if s.BoardOrder != nil {
			t.Errorf("board_order after %s = %v, want nil", clear, s.BoardOrder)
		}
	}
}

func TestApplyValue_rejectsInvalidWithoutMutation(t *testing.T) {
	cases := []struct {
		name  string
		key   string
		patch string
		check func(s *Settings) any // value to compare against its pre-apply state
	}{
		{"malformed color", "instance_color", `"99"`, func(s *Settings) any { return s.InstanceColor }},
		{"unknown flair token", "server_flairs", `{"dev": "sparkle"}`, func(s *Settings) any { return s.ServerFlairs }},
		{"invalid ssh host", "ssh_host", `"dev box"`, func(s *Settings) any { return s.SSHHost }},
		{"invalid instance name", "instance_name", `"my\u0007box"`, func(s *Settings) any { return s.InstanceName }},
		{"log_level outside enum", "log_level", `"trace"`, func(s *Settings) any { return s.LogLevel }},
		{"empty theme", "theme", `"  "`, func(s *Settings) any { return s.Theme }},
		{"non-bool auto_name", "auto_name", `"yes"`, func(s *Settings) any { return s.AutoName }},
		{"wrong type for map", "server_colors", `"4"`, func(s *Settings) any { return s.ServerColors }},
		{"wrong type for list", "board_order", `{"a":1}`, func(s *Settings) any { return s.BoardOrder }},
		{"wrong type for scalar", "theme", `42`, func(s *Settings) any { return s.Theme }},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			s := Default()
			s.InstanceColor = "4"
			s.ServerFlairs = map[string]string{"dev": "rain"}
			s.SSHHost = "devbox"
			s.InstanceName = "my-box"
			s.BoardOrder = []string{"a"}
			before := c.check(&s)

			if err := ApplyValue(&s, c.key, json.RawMessage(c.patch)); err == nil {
				t.Fatalf("ApplyValue(%q, %s) succeeded, want error", c.key, c.patch)
			}
			if after := c.check(&s); !reflect.DeepEqual(after, before) {
				t.Errorf("value mutated on rejection: before=%#v after=%#v", before, after)
			}
		})
	}
}

func TestApplyValue_unknownKey(t *testing.T) {
	s := Default()
	if err := ApplyValue(&s, "bogus_key", json.RawMessage(`1`)); err == nil {
		t.Fatal("ApplyValue(bogus_key) succeeded, want error")
	}
}

// TestApplyValue_portClearsPinNote pins the pin-comment contract: any
// successful registry write to port — set or null — clears PortPinNote (a
// user-chosen port is no longer the migration pin); a rejected write keeps it.
func TestApplyValue_portClearsPinNote(t *testing.T) {
	s := parse(PortPinComment + "\nport: 3000\n")
	if !s.PortPinNote {
		t.Fatal("precondition: parse did not set PortPinNote")
	}
	if err := ApplyValue(&s, "port", json.RawMessage(`6123`)); err != nil {
		t.Fatalf("apply port 6123: %v", err)
	}
	if s.Port != 6123 || s.PortPinNote {
		t.Errorf("after set: Port = %d, PortPinNote = %v — want 6123, false", s.Port, s.PortPinNote)
	}
	if got := serialize(s); strings.Contains(got, PortPinComment) {
		t.Errorf("serialize after set = %q, want no pin comment", got)
	}

	s = parse(PortPinComment + "\nport: 3000\n")
	if err := ApplyValue(&s, "port", json.RawMessage(`null`)); err != nil {
		t.Fatalf("apply port null: %v", err)
	}
	if s.Port != 0 || s.PortPinNote {
		t.Errorf("after null: Port = %d, PortPinNote = %v — want 0, false", s.Port, s.PortPinNote)
	}

	s = parse(PortPinComment + "\nport: 3000\n")
	if err := ApplyValue(&s, "port", json.RawMessage(`70000`)); err == nil {
		t.Fatal("apply port 70000 succeeded, want error")
	}
	if s.Port != 3000 || !s.PortPinNote {
		t.Errorf("after rejection: Port = %d, PortPinNote = %v — want unchanged 3000, true", s.Port, s.PortPinNote)
	}
}

// TestApplyValue_riffPresets pins the riff_presets per-entry merge: additions
// and built-in overrides set, entry null unsets, a non-object body and a
// malformed preset name are rejected without mutation.
func TestApplyValue_riffPresets(t *testing.T) {
	s := Default()

	// Add a user preset and override a built-in's value.
	if err := ApplyValue(&s, "riff_presets", json.RawMessage(`{"review": "/code-review high", "blank": "/fab-discuss"}`)); err != nil {
		t.Fatalf("apply riff_presets: %v", err)
	}
	want := map[string]string{"review": "/code-review high", "blank": "/fab-discuss"}
	if !reflect.DeepEqual(s.RiffPresets, want) {
		t.Fatalf("riff_presets = %v, want %v", s.RiffPresets, want)
	}

	// Entry null unsets just that entry.
	if err := ApplyValue(&s, "riff_presets", json.RawMessage(`{"review": null}`)); err != nil {
		t.Fatalf("apply riff_presets null entry: %v", err)
	}
	if !reflect.DeepEqual(s.RiffPresets, map[string]string{"blank": "/fab-discuss"}) {
		t.Errorf("riff_presets after unset = %v, want {blank: /fab-discuss}", s.RiffPresets)
	}

	// A non-object body is rejected without mutation.
	if err := ApplyValue(&s, "riff_presets", json.RawMessage(`"not an object"`)); err == nil {
		t.Fatal("ApplyValue(riff_presets, string) succeeded, want error")
	}
	if !reflect.DeepEqual(s.RiffPresets, map[string]string{"blank": "/fab-discuss"}) {
		t.Errorf("riff_presets mutated on rejection: %v", s.RiffPresets)
	}

	// A malformed preset name is rejected (strict write) without mutation.
	if err := ApplyValue(&s, "riff_presets", json.RawMessage(`{"-bad": "/x"}`)); err == nil {
		t.Fatal("ApplyValue(riff_presets, bad name) succeeded, want error")
	}
	if err := ApplyValue(&s, "riff_presets", json.RawMessage(`{"bad name": "/x"}`)); err == nil {
		t.Fatal("ApplyValue(riff_presets, spaced name) succeeded, want error")
	}
	if !reflect.DeepEqual(s.RiffPresets, map[string]string{"blank": "/fab-discuss"}) {
		t.Errorf("riff_presets mutated on bad-name rejection: %v", s.RiffPresets)
	}

	// A value carrying a double quote or a newline is rejected (strict write)
	// without mutation — the line-scoped format cannot round-trip it.
	if err := ApplyValue(&s, "riff_presets", json.RawMessage(`{"review": "/x \"quoted\""}`)); err == nil {
		t.Fatal("ApplyValue(riff_presets, quoted value) succeeded, want error")
	}
	if err := ApplyValue(&s, "riff_presets", json.RawMessage(`{"review": "/x\n/y"}`)); err == nil {
		t.Fatal("ApplyValue(riff_presets, newline value) succeeded, want error")
	}
	if !reflect.DeepEqual(s.RiffPresets, map[string]string{"blank": "/fab-discuss"}) {
		t.Errorf("riff_presets mutated on bad-value rejection: %v", s.RiffPresets)
	}

	// Top-level null clears the whole map.
	if err := ApplyValue(&s, "riff_presets", json.RawMessage(`null`)); err != nil {
		t.Fatalf("apply riff_presets null: %v", err)
	}
	if s.RiffPresets != nil {
		t.Errorf("riff_presets after top-level null = %v, want nil", s.RiffPresets)
	}
}

// TestRiffPresetsMergedView pins the merged accessor: built-ins first in
// canonical order (an override keeps BuiltIn with the user's value), user
// additions sorted after; never empty.
func TestRiffPresetsMergedView(t *testing.T) {
	t.Run("empty user map returns the three built-ins in canonical order", func(t *testing.T) {
		got := RiffPresets(Default())
		want := []RiffPreset{
			{Name: "discuss", Skill: "/fab-discuss", BuiltIn: true},
			{Name: "incognito", Skill: "/fab-incognito", BuiltIn: true},
			{Name: "blank", Skill: "", BuiltIn: true},
		}
		if !reflect.DeepEqual(got, want) {
			t.Errorf("RiffPresets(Default()) = %+v, want %+v", got, want)
		}
	})

	t.Run("override keeps BuiltIn, additions sort after", func(t *testing.T) {
		s := Default()
		s.RiffPresets = map[string]string{"blank": "/fab-discuss", "review": "/code-review high"}
		got := RiffPresets(s)
		want := []RiffPreset{
			{Name: "discuss", Skill: "/fab-discuss", BuiltIn: true},
			{Name: "incognito", Skill: "/fab-incognito", BuiltIn: true},
			{Name: "blank", Skill: "/fab-discuss", BuiltIn: true},
			{Name: "review", Skill: "/code-review high", BuiltIn: false},
		}
		if !reflect.DeepEqual(got, want) {
			t.Errorf("RiffPresets() = %+v, want %+v", got, want)
		}
		m := RiffPresetMap(got)
		if m["blank"] != "/fab-discuss" || m["review"] != "/code-review high" || len(m) != 4 {
			t.Errorf("RiffPresetMap() = %v", m)
		}
	})

	t.Run("LoadRiffPresets on an isolated empty root returns the built-ins", func(t *testing.T) {
		t.Setenv(ConfigDirEnv, t.TempDir())
		got := LoadRiffPresets()
		if len(got) != len(BuiltinRiffPresets) {
			t.Fatalf("LoadRiffPresets() = %d presets, want %d built-ins", len(got), len(BuiltinRiffPresets))
		}
	})
}
