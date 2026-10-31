package api

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"strconv"
	"strings"
	"testing"
	"time"

	"rk/internal/daemon"
	"rk/internal/portpolicy"
	"rk/internal/settings"
)

// isolateSettings points settings persistence at a throwaway HOME so the tests
// neither read nor clobber the developer's real ~/.config/hexokit/config.yaml.
func isolateSettings(t *testing.T) {
	t.Helper()
	t.Setenv("HOME", t.TempDir())
}

func postJSON(t *testing.T, router http.Handler, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	return rec
}

// getSettingsMap GETs /api/settings and returns the entries keyed by settings
// key (order assertions use getSettingsList instead).
func getSettingsMap(t *testing.T, router http.Handler) map[string]settingEntry {
	t.Helper()
	entries := getSettingsList(t, router)
	byKey := make(map[string]settingEntry, len(entries))
	for _, e := range entries {
		byKey[e.Key] = e
	}
	return byKey
}

func getSettingsList(t *testing.T, router http.Handler) []settingEntry {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/api/settings", nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /api/settings status = %d, want %d; body=%s", rec.Code, http.StatusOK, rec.Body.String())
	}
	var result struct {
		Settings []settingEntry `json:"settings"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&result); err != nil {
		t.Fatalf("decode: %v", err)
	}
	return result.Settings
}

// --- GET /api/settings ---

func TestGetSettings_registryOrderAndDefaults(t *testing.T) {
	isolateSettings(t)
	router := newTestRouter(&mockSessionFetcher{}, &mockTmuxOps{})

	entries := getSettingsList(t, router)
	wantKeys := []string{
		"theme", "theme_dark", "theme_light", "instance_color", "ssh_host", "port",
		"instance_name", "auto_name", "cron_ticker", "easter_eggs", "gui.enabled", "gui.wm", "gui.geometry",
		"tmux_conf",
		"log_level", "server_colors", "server_flairs", "board_order", "riff_presets",
	}
	if len(entries) != len(wantKeys) {
		t.Fatalf("GET returned %d entries, want %d", len(entries), len(wantKeys))
	}
	for i, key := range wantKeys {
		if entries[i].Key != key {
			t.Errorf("entries[%d].Key = %q, want %q", i, entries[i].Key, key)
		}
	}

	byKey := make(map[string]settingEntry, len(entries))
	for _, e := range entries {
		byKey[e.Key] = e
		if e.Description == "" || e.Kind == "" || e.Category == "" {
			t.Errorf("entry %q missing metadata: %+v", e.Key, e)
		}
	}
	// Fresh-instance defaults (values decode into interface{} shapes).
	if got := byKey["theme"].Value; got != "system" {
		t.Errorf("theme.value = %v, want %q", got, "system")
	}
	if got := byKey["instance_color"].Value; got != nil {
		t.Errorf("instance_color.value = %v, want null", got)
	}
	if got := byKey["ssh_host"].Value; got != nil {
		t.Errorf("ssh_host.value = %v, want null", got)
	}
	portDefault := strconv.Itoa(portpolicy.DaemonDefault)
	if e := byKey["port"]; e.Kind != "port" || e.Default != portDefault || e.UI != false || e.Live != false || e.Value != nil {
		t.Errorf("port entry = %+v, want kind=port default=%s ui=false live=false value=null", e, portDefault)
	}
	if got, ok := byKey["server_colors"].Value.(map[string]any); !ok || len(got) != 0 {
		t.Errorf("server_colors.value = %v, want {}", byKey["server_colors"].Value)
	}
	if got, ok := byKey["board_order"].Value.([]any); !ok || len(got) != 0 {
		t.Errorf("board_order.value = %v, want []", byKey["board_order"].Value)
	}
	if got, ok := byKey["riff_presets"].Value.(map[string]any); !ok || len(got) != 0 {
		t.Errorf("riff_presets.value = %v, want {} (the stored user tier is empty at default)", byKey["riff_presets"].Value)
	}
	if got := byKey["auto_name"].Value; got != false {
		t.Errorf("auto_name.value = %v, want false", got)
	}
	if got := byKey["cron_ticker"].Value; got != true {
		t.Errorf("cron_ticker.value = %v, want true", got)
	}
	if e := byKey["easter_eggs"]; e.Kind != "bool" || e.Default != "true" || e.Value != true || e.Options != nil {
		t.Errorf("easter_eggs entry = %+v, want kind=bool default=true value=true options=nil", e)
	}
	if got := byKey["gui.enabled"].Value; got != false {
		t.Errorf("gui.enabled.value = %v, want false", got)
	}
	if got := byKey["log_level"].Value; got != "info" {
		t.Errorf("log_level.value = %v, want %q", got, "info")
	}
}

func TestGetSettings_reflectsStoredValues(t *testing.T) {
	isolateSettings(t)
	router := newTestRouter(&mockSessionFetcher{}, &mockTmuxOps{})

	color := "4"
	if err := settings.SetInstanceColor(&color); err != nil {
		t.Fatalf("seed color: %v", err)
	}
	if err := settings.SetBoardOrder([]string{"deploys", "reviews"}); err != nil {
		t.Fatalf("seed order: %v", err)
	}
	if err := settings.SetServerColor("default", &color); err != nil {
		t.Fatalf("seed server color: %v", err)
	}

	byKey := getSettingsMap(t, router)
	if got := byKey["instance_color"].Value; got != "4" {
		t.Errorf("instance_color.value = %v, want %q", got, "4")
	}
	colors, ok := byKey["server_colors"].Value.(map[string]any)
	if !ok || colors["default"] != "4" {
		t.Errorf("server_colors.value = %v, want {default: 4}", byKey["server_colors"].Value)
	}
	order, ok := byKey["board_order"].Value.([]any)
	if !ok || len(order) != 2 || order[0] != "deploys" || order[1] != "reviews" {
		t.Errorf("board_order.value = %v, want [deploys reviews]", byKey["board_order"].Value)
	}
}

// --- GET /api/settings: enum options ---

func TestGetSettings_enumOptionsWireShape(t *testing.T) {
	isolateSettings(t)
	router := newTestRouter(&mockSessionFetcher{}, &mockTmuxOps{})

	req := httptest.NewRequest(http.MethodGet, "/api/settings", nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /api/settings status = %d, want %d; body=%s", rec.Code, http.StatusOK, rec.Body.String())
	}
	var result struct {
		Settings []map[string]any `json:"settings"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&result); err != nil {
		t.Fatalf("decode: %v", err)
	}
	byKey := make(map[string]map[string]any, len(result.Settings))
	for _, e := range result.Settings {
		key, _ := e["key"].(string)
		byKey[key] = e
	}

	wantOptions := map[string][]any{
		"theme":     {"system", "dark", "light"},
		"log_level": {"info", "debug"},
	}
	for key, want := range wantOptions {
		got, present := byKey[key]["options"]
		if !present {
			t.Errorf("%s: options key absent, want %v", key, want)
			continue
		}
		if !reflect.DeepEqual(got, want) {
			t.Errorf("%s: options = %v, want %v", key, got, want)
		}
	}

	// Non-enum kinds omit the options key entirely (omitempty).
	for _, key := range []string{
		"theme_dark", "theme_light", "instance_color", "ssh_host",
		"instance_name", "auto_name", "cron_ticker", "gui.geometry", "tmux_conf",
		"server_colors", "server_flairs", "board_order",
	} {
		if _, present := byKey[key]["options"]; present {
			t.Errorf("%s: options key present on a non-enum kind: %v", key, byKey[key]["options"])
		}
	}
}

// --- POST /api/settings: merge semantics ---

func TestPostSettings_setAbsentNull(t *testing.T) {
	isolateSettings(t)
	router := newTestRouter(&mockSessionFetcher{}, &mockTmuxOps{})

	// Seed one key, patch another — the absent key is untouched.
	name := "my-box"
	if err := settings.SetInstanceName(&name); err != nil {
		t.Fatalf("seed: %v", err)
	}
	rec := postJSON(t, router, "/api/settings", `{"ssh_host": "devbox"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body=%s", rec.Code, http.StatusOK, rec.Body.String())
	}
	var result map[string]string
	if err := json.NewDecoder(rec.Body).Decode(&result); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if result["status"] != "ok" {
		t.Errorf("status field = %q, want %q", result["status"], "ok")
	}
	if got := settings.Load(); got.SSHHost != "devbox" || got.InstanceName != "my-box" {
		t.Errorf("after patch: ssh_host=%q instance_name=%q, want devbox/my-box", got.SSHHost, got.InstanceName)
	}

	// Null unsets (back to the registry default).
	rec = postJSON(t, router, "/api/settings", `{"instance_name": null}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("null unset: status = %d, want %d; body=%s", rec.Code, http.StatusOK, rec.Body.String())
	}
	if got := settings.GetInstanceName(); got != nil {
		t.Errorf("instance_name after null = %q, want nil", *got)
	}
	// A subsequent GET surfaces null for the unset scalar.
	if got := getSettingsMap(t, router)["instance_name"].Value; got != nil {
		t.Errorf("GET instance_name.value after unset = %v, want null", got)
	}
}

func TestPostSettings_emptyStringEqualsNull(t *testing.T) {
	isolateSettings(t)
	router := newTestRouter(&mockSessionFetcher{}, &mockTmuxOps{})

	host := "devbox"
	if err := settings.SetSSHHost(&host); err != nil {
		t.Fatalf("seed: %v", err)
	}
	rec := postJSON(t, router, "/api/settings", `{"ssh_host": "   "}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body=%s", rec.Code, http.StatusOK, rec.Body.String())
	}
	if got := settings.GetSSHHost(); got != nil {
		t.Errorf("ssh_host after trimmed-empty = %q, want nil", *got)
	}
}

func TestPostSettings_trimsScalarValues(t *testing.T) {
	isolateSettings(t)
	router := newTestRouter(&mockSessionFetcher{}, &mockTmuxOps{})

	rec := postJSON(t, router, "/api/settings", `{"ssh_host": "  devbox  ", "instance_name": " dev mini "}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body=%s", rec.Code, http.StatusOK, rec.Body.String())
	}
	got := settings.Load()
	if got.SSHHost != "devbox" || got.InstanceName != "dev mini" {
		t.Errorf("trimmed values: ssh_host=%q instance_name=%q, want devbox / \"dev mini\"", got.SSHHost, got.InstanceName)
	}
}

func TestPostSettings_perEntryMapMerge(t *testing.T) {
	isolateSettings(t)
	router := newTestRouter(&mockSessionFetcher{}, &mockTmuxOps{})

	four, two := "4", "2"
	if err := settings.SetServerColor("dev", &four); err != nil {
		t.Fatalf("seed dev: %v", err)
	}
	if err := settings.SetServerColor("prod", &two); err != nil {
		t.Fatalf("seed prod: %v", err)
	}

	rec := postJSON(t, router, "/api/settings", `{"server_colors": {"dev": null, "stage": "1+3"}}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body=%s", rec.Code, http.StatusOK, rec.Body.String())
	}
	got := settings.Load().ServerColors
	if len(got) != 2 || got["prod"] != "2" || got["stage"] != "1+3" {
		t.Errorf("server_colors = %v, want {prod: 2, stage: 1+3}", got)
	}

	// Top-level null clears the whole map.
	rec = postJSON(t, router, "/api/settings", `{"server_colors": null}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("clear: status = %d, want %d", rec.Code, http.StatusOK)
	}
	if got := settings.Load().ServerColors; len(got) != 0 {
		t.Errorf("server_colors after top-level null = %v, want empty", got)
	}
}

func TestPostSettings_flairEmptyStringUnsetsEntry(t *testing.T) {
	isolateSettings(t)
	router := newTestRouter(&mockSessionFetcher{}, &mockTmuxOps{})

	flair := "rain"
	if err := settings.SetServerFlair("default", &flair); err != nil {
		t.Fatalf("seed: %v", err)
	}
	rec := postJSON(t, router, "/api/settings", `{"server_flairs": {"default": ""}}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body=%s", rec.Code, http.StatusOK, rec.Body.String())
	}
	if got := settings.GetServerFlair("default"); got != nil {
		t.Errorf("flair after empty-string entry = %q, want nil", *got)
	}
}

func TestPostSettings_boardOrderReplacesWholesale(t *testing.T) {
	isolateSettings(t)
	router := newTestRouter(&mockSessionFetcher{}, &mockTmuxOps{})

	if err := settings.SetBoardOrder([]string{"deploys"}); err != nil {
		t.Fatalf("seed: %v", err)
	}
	rec := postJSON(t, router, "/api/settings", `{"board_order": ["reviews", "deploys"]}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body=%s", rec.Code, http.StatusOK, rec.Body.String())
	}
	if got := settings.GetBoardOrder(); len(got) != 2 || got[0] != "reviews" || got[1] != "deploys" {
		t.Errorf("board_order = %v, want [reviews deploys]", got)
	}

	// Top-level null and [] both clear.
	for _, body := range []string{`{"board_order": null}`, `{"board_order": []}`} {
		rec = postJSON(t, router, "/api/settings", body)
		if rec.Code != http.StatusOK {
			t.Fatalf("body %s: status = %d, want %d", body, rec.Code, http.StatusOK)
		}
		if got := settings.GetBoardOrder(); got != nil {
			t.Errorf("body %s: board_order = %v, want nil", body, got)
		}
	}
}

// --- POST /api/settings: validation, all-or-nothing ---

func TestPostSettings_unknownKeyRejected(t *testing.T) {
	isolateSettings(t)
	router := newTestRouter(&mockSessionFetcher{}, &mockTmuxOps{})

	rec := postJSON(t, router, "/api/settings", `{"theme": "dark", "bogus_key": 1}`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusBadRequest)
	}
	if got := settings.Load().Theme; got != "system" {
		t.Errorf("theme persisted as %q despite unknown key, want unchanged %q", got, "system")
	}
}

func TestPostSettings_perKeyValidation400s(t *testing.T) {
	longValue := strings.Repeat("a", 254)
	cases := []struct {
		name string
		body string
	}{
		{"malformed instance_color", `{"instance_color": "99"}`},
		{"malformed server color entry", `{"server_colors": {"dev": "1+2+3"}}`},
		{"unknown flair token", `{"server_flairs": {"dev": "sparkle"}}`},
		{"invalid ssh_host", `{"ssh_host": "dev box"}`},
		{"over-long ssh_host", `{"ssh_host": "` + longValue + `"}`},
		{"invalid instance_name", `{"instance_name": "my\u0007box"}`},
		{"invalid board name", `{"board_order": ["ok", "bad name!"]}`},
		{"duplicate board name", `{"board_order": ["a", "b", "a"]}`},
		{"log_level outside enum", `{"log_level": "trace"}`},
		{"empty theme", `{"theme": "  "}`},
		{"non-bool auto_name", `{"auto_name": "yes"}`},
		{"wrong type for map", `{"server_colors": "4"}`},
		{"wrong type for scalar", `{"theme": 42}`},
		{"wrong type for list", `{"board_order": {"a": 1}}`},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			isolateSettings(t)
			router := newTestRouter(&mockSessionFetcher{}, &mockTmuxOps{})
			rec := postJSON(t, router, "/api/settings", c.body)
			if rec.Code != http.StatusBadRequest {
				t.Errorf("body %s: status = %d, want %d; body=%s", c.body, rec.Code, http.StatusBadRequest, rec.Body.String())
			}
			// Nothing persisted on a 400.
			if got := settings.Load(); !settingsEqual(got, settings.Default()) {
				t.Errorf("body %s: settings persisted despite 400: %+v", c.body, got)
			}
		})
	}
}

// settingsEqual reports whether two Settings carry the same values.
func settingsEqual(a, b settings.Settings) bool {
	aJSON, _ := json.Marshal(a)
	bJSON, _ := json.Marshal(b)
	return string(aJSON) == string(bJSON)
}

func TestPostSettings_allOrNothing(t *testing.T) {
	isolateSettings(t)
	router := newTestRouter(&mockSessionFetcher{}, &mockTmuxOps{})

	// A valid key plus an invalid one in the same body: the valid key must
	// NOT persist either.
	rec := postJSON(t, router, "/api/settings", `{"ssh_host": "devbox", "board_order": ["deploys", "deploys"]}`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusBadRequest)
	}
	if got := settings.GetSSHHost(); got != nil {
		t.Errorf("ssh_host persisted as %q despite sibling failure, want nil", *got)
	}
	if got := settings.GetBoardOrder(); got != nil {
		t.Errorf("board_order persisted as %v despite duplicate rejection, want nil", got)
	}
}

func TestPostSettings_malformedBody(t *testing.T) {
	isolateSettings(t)
	router := newTestRouter(&mockSessionFetcher{}, &mockTmuxOps{})

	for _, body := range []string{`{"theme":`, `not json`, `[1,2]`} {
		rec := postJSON(t, router, "/api/settings", body)
		if rec.Code != http.StatusBadRequest {
			t.Errorf("body %q: status = %d, want %d", body, rec.Code, http.StatusBadRequest)
		}
	}
}

// --- POST /api/settings: board-order SSE broadcast ---

func TestPostSettings_boardOrderBroadcasts(t *testing.T) {
	isolateSettings(t)
	ops := &mockTmuxOps{}
	logger := slog.New(slog.NewTextHandler(os.Stderr, nil))
	server := &Server{logger: logger, sessions: &mockSessionFetcher{}, tmux: ops, hostname: "test"}
	server.initSSEHub()
	client := server.sseHub.addTestClient(make(chan hubEvent, 16), "default")
	defer server.sseHub.removeClient(client)
	drainSSE(client)

	router := server.buildRouter()
	rec := postJSON(t, router, "/api/settings", `{"board_order": ["reviews", "deploys"]}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body=%s", rec.Code, rec.Body.String())
	}
	if got := settings.GetBoardOrder(); len(got) != 2 || got[0] != "reviews" || got[1] != "deploys" {
		t.Errorf("persisted order = %v, want [reviews deploys]", got)
	}

	deadline := time.After(500 * time.Millisecond)
	for {
		select {
		case ev := <-client.ch:
			s := ev.String()
			if strings.Contains(s, "event: board-order") {
				if !strings.Contains(s, `{"order":["reviews","deploys"]}`) {
					t.Errorf("board-order payload = %q", s)
				}
				return
			}
		case <-deadline:
			t.Fatal("did not receive board-order event")
		}
	}
}

func TestPostSettings_withoutBoardOrderBroadcastsNothing(t *testing.T) {
	isolateSettings(t)
	ops := &mockTmuxOps{}
	logger := slog.New(slog.NewTextHandler(os.Stderr, nil))
	server := &Server{logger: logger, sessions: &mockSessionFetcher{}, tmux: ops, hostname: "test", autoNameEnabled: true}
	server.initSSEHub()
	client := server.sseHub.addTestClient(make(chan hubEvent, 16), "default")
	defer server.sseHub.removeClient(client)
	drainSSE(client)

	tracker := server.sseHub.getAutoName()
	if tracker == nil {
		t.Fatal("auto-name tracker missing with autoNameEnabled=true")
	}

	router := server.buildRouter()
	rec := postJSON(t, router, "/api/settings", `{"theme": "dark"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body=%s", rec.Code, rec.Body.String())
	}

	// A patch without auto_name never touches the tracker wiring — the same
	// tracker instance must survive the save.
	if got := server.sseHub.getAutoName(); got != tracker {
		t.Errorf("auto-name tracker rewired by a patch without auto_name")
	}

	select {
	case ev := <-client.ch:
		if strings.Contains(ev.String(), "event: board-order") {
			t.Errorf("unexpected board-order event: %q", ev.String())
		}
	case <-time.After(150 * time.Millisecond):
	}
}

// --- POST /api/settings: auto_name live rewire ---

func TestPostSettings_autoNameRewiresTracker(t *testing.T) {
	newServer := func(enabled bool) *Server {
		logger := slog.New(slog.NewTextHandler(os.Stderr, nil))
		server := &Server{logger: logger, sessions: &mockSessionFetcher{}, tmux: &mockTmuxOps{}, hostname: "test", autoNameEnabled: enabled}
		server.initSSEHub()
		return server
	}

	t.Run("enable installs a deliver-wired tracker", func(t *testing.T) {
		isolateSettings(t)
		server := newServer(false)
		if got := server.sseHub.getAutoName(); got != nil {
			t.Fatal("tracker present before POST with auto_name off")
		}
		rec := postJSON(t, server.buildRouter(), "/api/settings", `{"auto_name": true}`)
		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d, body=%s", rec.Code, rec.Body.String())
		}
		tracker := server.sseHub.getAutoName()
		if tracker == nil {
			t.Fatal("tracker missing after enabling auto_name")
		}
		if tracker.deliver == nil {
			t.Error("deliver seam not wired after enabling auto_name")
		}
		if got := settings.Load().AutoName; !got {
			t.Error("auto_name persisted as false, want true")
		}
	})

	t.Run("disable nils the tracker", func(t *testing.T) {
		isolateSettings(t)
		server := newServer(true)
		if got := server.sseHub.getAutoName(); got == nil {
			t.Fatal("tracker missing before POST with auto_name on")
		}
		rec := postJSON(t, server.buildRouter(), "/api/settings", `{"auto_name": false}`)
		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d, body=%s", rec.Code, rec.Body.String())
		}
		if got := server.sseHub.getAutoName(); got != nil {
			t.Error("tracker present after disabling auto_name")
		}
	})

	t.Run("null unsets to the default off", func(t *testing.T) {
		isolateSettings(t)
		server := newServer(true)
		rec := postJSON(t, server.buildRouter(), "/api/settings", `{"auto_name": null}`)
		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d, body=%s", rec.Code, rec.Body.String())
		}
		if got := server.sseHub.getAutoName(); got != nil {
			t.Error("tracker present after null unset (default off)")
		}
		if got := settings.Load().AutoName; got {
			t.Error("auto_name persisted as true after null unset, want false")
		}
	})

	t.Run("re-enable builds a fresh tracker", func(t *testing.T) {
		isolateSettings(t)
		server := newServer(true)
		before := server.sseHub.getAutoName()
		router := server.buildRouter()
		if rec := postJSON(t, router, "/api/settings", `{"auto_name": false}`); rec.Code != http.StatusOK {
			t.Fatalf("disable: status = %d, body=%s", rec.Code, rec.Body.String())
		}
		if rec := postJSON(t, router, "/api/settings", `{"auto_name": true}`); rec.Code != http.StatusOK {
			t.Fatalf("re-enable: status = %d, body=%s", rec.Code, rec.Body.String())
		}
		after := server.sseHub.getAutoName()
		if after == nil {
			t.Fatal("tracker missing after re-enable")
		}
		if after == before {
			t.Error("re-enable reused the old tracker — cooldown state must not survive a disable")
		}
	})
}

// --- Hard fold: the per-key endpoints are gone ---

func TestFoldedEndpoints_areGone(t *testing.T) {
	isolateSettings(t)
	router := newTestRouter(&mockSessionFetcher{}, &mockTmuxOps{})

	paths := []string{
		"/api/settings/theme",
		"/api/settings/server-color",
		"/api/settings/server-flair",
		"/api/settings/instance-color",
		"/api/settings/ssh-host",
		"/api/settings/instance-name",
	}
	for _, path := range paths {
		for _, method := range []string{http.MethodGet, http.MethodPost} {
			req := httptest.NewRequest(method, path, nil)
			rec := httptest.NewRecorder()
			router.ServeHTTP(rec, req)
			if rec.Code != http.StatusNotFound && rec.Code != http.StatusMethodNotAllowed {
				t.Errorf("%s %s: status = %d, want 404/405 (endpoint folded)", method, path, rec.Code)
			}
		}
	}

	req := httptest.NewRequest(http.MethodPost, "/api/boards/order", strings.NewReader(`{"order":["a"]}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusNotFound && rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("POST /api/boards/order: status = %d, want 404/405 (endpoint folded)", rec.Code)
	}
}

// --- POST /api/settings: gui.enabled side effect ---

// newGuiSideEffectServer builds a routed-capable server with the gui
// ensure/kill seams stubbed to call counters.
func newGuiSideEffectServer() (*Server, *int, *int) {
	ensures, kills := new(int), new(int)
	logger := slog.New(slog.NewTextHandler(os.Stderr, nil))
	server := &Server{
		logger:   logger,
		sessions: &mockSessionFetcher{},
		tmux:     &mockTmuxOps{},
		hostname: "test-host",
		guiEnsureFn: func() (daemon.GUIEnsureOutcome, error) {
			*ensures++
			return daemon.GUIEnsureStarted, nil
		},
		guiKillFn: func() (bool, error) { *kills++; return true, nil },
	}
	return server, ensures, kills
}

func TestPostSettings_guiEnabledTrueEnsuresOnce(t *testing.T) {
	isolateSettings(t)
	server, ensures, kills := newGuiSideEffectServer()
	rec := postJSON(t, server.buildRouter(), "/api/settings", `{"gui.enabled": true}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body=%s", rec.Code, rec.Body.String())
	}
	if *ensures != 1 || *kills != 0 {
		t.Errorf("ensures=%d kills=%d, want 1/0", *ensures, *kills)
	}
	if !settings.Load().GUIEnabled {
		t.Error("gui.enabled not persisted")
	}
	// The hub's gui slot flips synchronously with the POST (no tick wait).
	server.sseHub.mu.RLock()
	enabled := server.sseHub.guiEnabled
	server.sseHub.mu.RUnlock()
	if !enabled {
		t.Error("hub guiEnabled not flipped synchronously by the POST")
	}
}

func TestPostSettings_guiEnabledFalseKillsOnce(t *testing.T) {
	isolateSettings(t)
	server, ensures, kills := newGuiSideEffectServer()
	router := server.buildRouter()
	if rec := postJSON(t, router, "/api/settings", `{"gui.enabled": true}`); rec.Code != http.StatusOK {
		t.Fatalf("enable: status = %d", rec.Code)
	}
	rec := postJSON(t, router, "/api/settings", `{"gui.enabled": false}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body=%s", rec.Code, rec.Body.String())
	}
	if *ensures != 1 || *kills != 1 {
		t.Errorf("ensures=%d kills=%d, want 1/1", *ensures, *kills)
	}
	server.sseHub.mu.RLock()
	enabled := server.sseHub.guiEnabled
	server.sseHub.mu.RUnlock()
	if enabled {
		t.Error("hub guiEnabled still true after the off POST")
	}
}

func TestPostSettings_guiEnabledNullUnsetsAndKills(t *testing.T) {
	enableGuiSettings(t)
	server, _, kills := newGuiSideEffectServer()
	rec := postJSON(t, server.buildRouter(), "/api/settings", `{"gui.enabled": null}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body=%s", rec.Code, rec.Body.String())
	}
	if *kills != 1 {
		t.Errorf("kills=%d, want 1 (null resets to the default off)", *kills)
	}
	if settings.Load().GUIEnabled {
		t.Error("gui.enabled persisted as true after null unset, want false")
	}
}

func TestPostSettings_unrelatedKeysCallNeitherGuiSeam(t *testing.T) {
	isolateSettings(t)
	server, ensures, kills := newGuiSideEffectServer()
	router := server.buildRouter()
	for _, body := range []string{`{"theme": "dark"}`, `{"auto_name": true}`, `{"board_order": ["reviews"]}`} {
		if rec := postJSON(t, router, "/api/settings", body); rec.Code != http.StatusOK {
			t.Fatalf("body %s: status = %d, body=%s", body, rec.Code, rec.Body.String())
		}
	}
	if *ensures != 0 || *kills != 0 {
		t.Errorf("ensures=%d kills=%d, want 0/0 for unrelated keys", *ensures, *kills)
	}
}

func TestPostSettings_guiEnsureFailureIsBestEffort(t *testing.T) {
	isolateSettings(t)
	server, _, _ := newGuiSideEffectServer()
	server.guiEnsureFn = func() (daemon.GUIEnsureOutcome, error) {
		return daemon.GUIEnsureStateDirFailed, fmt.Errorf("no free display")
	}
	rec := postJSON(t, server.buildRouter(), "/api/settings", `{"gui.enabled": true}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (best-effort side effect); body=%s", rec.Code, rec.Body.String())
	}
	if !settings.Load().GUIEnabled {
		t.Error("gui.enabled not persisted despite the ensure failure")
	}
}

// --- POST /api/settings: gui.geometry live resize side effect ---

// A fixed geometry on an enabled, reachable rig applies live: the runner sees
// the query then the resize steps, and the response stays 200.
func TestPostSettings_guiGeometryFixedResizesLive(t *testing.T) {
	server, router := newGuiAPIServer(t, true)
	var calls []xrandrCall
	server.guiXrandrRunFn = recordingXrandrRunner(&calls, "", nil)

	rec := postJSON(t, router, "/api/settings", `{"gui.geometry": "1280x720"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	if got := settings.Load().GUIGeometry; got != "1280x720" {
		t.Errorf("GUIGeometry = %q, want 1280x720 persisted", got)
	}
	// 1280x720 is listed in the fake query, so the resize is the single
	// --output --mode step on the status's display.
	want := []xrandrCall{
		{":10", []string{"xrandr", "--query"}},
		{":10", []string{"xrandr", "--output", "VNC-0", "--mode", "1280x720"}},
	}
	if !reflect.DeepEqual(calls, want) {
		t.Errorf("xrandr calls = %+v, want %+v", calls, want)
	}
}

// Disabled GUI: the setting still saves (the generic path owns persistence)
// but no xrandr runs.
func TestPostSettings_guiGeometryDisabledSkipsResize(t *testing.T) {
	server, router := newGuiAPIServer(t, false)
	server.guiXrandrRunFn = failIfXrandrRuns(t)

	rec := postJSON(t, router, "/api/settings", `{"gui.geometry": "1280x720"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	if got := settings.Load().GUIGeometry; got != "1280x720" {
		t.Errorf("GUIGeometry = %q, want 1280x720 persisted", got)
	}
}

// "auto" needs no live action — the stream's geometry flips resizeSession.
func TestPostSettings_guiGeometryAutoSkipsResize(t *testing.T) {
	server, router := newGuiAPIServer(t, true)
	server.guiXrandrRunFn = failIfXrandrRuns(t)

	rec := postJSON(t, router, "/api/settings", `{"gui.geometry": "auto"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	if got := settings.Load().GUIGeometry; got != "auto" {
		t.Errorf("GUIGeometry = %q, want auto persisted", got)
	}
}
