package api

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"

	"rk/internal/daemon/autostart"
)

func autostartRequest(t *testing.T, probe func(context.Context) (autostart.Status, error), method string) *httptest.ResponseRecorder {
	t.Helper()
	logger := slog.New(slog.NewTextHandler(os.Stderr, nil))
	router, s := NewTestRouterAndServer(logger, nil, nil, "test-host")
	s.autostartStatusFn = probe
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, httptest.NewRequest(method, "/api/daemon/autostart", nil))
	return rec
}

func TestDaemonAutostartSupported(t *testing.T) {
	yes, no := true, false
	cases := []struct {
		name        string
		status      autostart.Status
		wantSummary string
		wantStartAt string
	}{
		{"boot", autostart.Status{Registered: true, Enabled: true, StartsAt: autostart.StartsAtBoot, Linger: &yes}, "on (boot)", "boot"},
		{"login only", autostart.Status{Registered: true, Enabled: true, StartsAt: autostart.StartsAtLogin, Linger: &no}, "on (login only — enable lingering for boot)", "login"},
		{"off", autostart.Status{}, "off", ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rec := autostartRequest(t, func(context.Context) (autostart.Status, error) { return tc.status, nil }, http.MethodGet)
			if rec.Code != http.StatusOK {
				t.Fatalf("status = %d, want 200", rec.Code)
			}
			if ct := rec.Header().Get("Content-Type"); ct != "application/json" {
				t.Errorf("Content-Type = %q", ct)
			}
			var body struct {
				Supported bool           `json:"supported"`
				Summary   string         `json:"summary"`
				Status    map[string]any `json:"status"`
				Error     *string        `json:"error"`
			}
			if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
				t.Fatalf("decode: %v", err)
			}
			if !body.Supported || body.Summary != tc.wantSummary {
				t.Errorf("supported=%v summary=%q, want true %q", body.Supported, body.Summary, tc.wantSummary)
			}
			if got := body.Status["starts_at"]; got != tc.wantStartAt {
				t.Errorf("status.starts_at = %v, want %q", got, tc.wantStartAt)
			}
			if body.Status["registered"] != tc.status.Registered {
				t.Errorf("status.registered = %v, want %v", body.Status["registered"], tc.status.Registered)
			}
			if body.Error != nil {
				t.Errorf("error = %q on a supported response", *body.Error)
			}
		})
	}
}

func TestDaemonAutostartProbeError(t *testing.T) {
	rec := autostartRequest(t, func(context.Context) (autostart.Status, error) {
		return autostart.Status{}, errors.New("daemon autostart is not supported on darwin (supported: linux)")
	}, http.MethodGet)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (unavailable is data)", rec.Code)
	}
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if body["supported"] != false || body["summary"] != "unavailable" {
		t.Errorf("body = %v", body)
	}
	if body["error"] != "daemon autostart is not supported on darwin (supported: linux)" {
		t.Errorf("error = %v", body["error"])
	}
	if _, ok := body["status"]; ok {
		t.Errorf("unsupported response carries status: %v", body)
	}
}

func TestDaemonAutostartIsReadOnly(t *testing.T) {
	probed := false
	rec := autostartRequest(t, func(context.Context) (autostart.Status, error) {
		probed = true
		return autostart.Status{}, nil
	}, http.MethodPost)
	if rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("POST status = %d, want 405", rec.Code)
	}
	if probed {
		t.Error("POST reached the autostart probe")
	}
}
