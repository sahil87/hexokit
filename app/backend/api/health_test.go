package api

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"

	"rk/internal/portpolicy"
	"rk/internal/settings"
)

func TestHealthEndpoint(t *testing.T) {
	isolateSettings(t)
	logger := slog.New(slog.NewTextHandler(os.Stderr, nil))
	router := NewTestRouter(logger, nil, nil, "test-host")

	req := httptest.NewRequest(http.MethodGet, "/api/health", nil)
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusOK)
	}

	ct := rec.Header().Get("Content-Type")
	if ct != "application/json" {
		t.Errorf("Content-Type = %q, want %q", ct, "application/json")
	}

	var body map[string]any
	if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
		t.Fatalf("failed to decode response: %v", err)
	}

	if body["status"] != "ok" {
		t.Errorf("body.status = %q, want %q", body["status"], "ok")
	}

	if body["hostname"] != "test-host" {
		t.Errorf("body.hostname = %q, want %q", body["hostname"], "test-host")
	}
}

func TestHealthEndpointEmptyHostname(t *testing.T) {
	isolateSettings(t)
	logger := slog.New(slog.NewTextHandler(os.Stderr, nil))
	router := NewTestRouter(logger, nil, nil, "")

	req := httptest.NewRequest(http.MethodGet, "/api/health", nil)
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusOK)
	}

	var body map[string]any
	if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
		t.Fatalf("failed to decode response: %v", err)
	}

	if body["status"] != "ok" {
		t.Errorf("body.status = %q, want %q", body["status"], "ok")
	}

	if body["hostname"] != "" {
		t.Errorf("body.hostname = %q, want %q", body["hostname"], "")
	}
}

// The optional sshHost field rides the health response, resolved per request
// from the `ssh_host` setting — the ONLY source: an RK_SSH_HOST env value is
// ignored, and the field is absent (not empty-valued) when the setting is
// unset.
func TestHealthEndpointSSHHost(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(os.Stderr, nil))

	t.Run("present when the setting is set", func(t *testing.T) {
		isolateSettings(t)
		host := "devbox"
		if err := settings.SetSSHHost(&host); err != nil {
			t.Fatalf("SetSSHHost: %v", err)
		}
		router := NewTestRouter(logger, nil, nil, "test-host")

		req := httptest.NewRequest(http.MethodGet, "/api/health", nil)
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)

		var body map[string]any
		if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
			t.Fatalf("failed to decode response: %v", err)
		}
		if body["sshHost"] != "devbox" {
			t.Errorf("body.sshHost = %q, want %q", body["sshHost"], "devbox")
		}
	})

	t.Run("absent when unset", func(t *testing.T) {
		isolateSettings(t)
		router := NewTestRouter(logger, nil, nil, "test-host")

		req := httptest.NewRequest(http.MethodGet, "/api/health", nil)
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)

		var body map[string]any
		if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
			t.Fatalf("failed to decode response: %v", err)
		}
		if _, present := body["sshHost"]; present {
			t.Errorf("body.sshHost present (%q), want absent", body["sshHost"])
		}
	})

	t.Run("RK_SSH_HOST env is ignored", func(t *testing.T) {
		isolateSettings(t)
		t.Setenv("RK_SSH_HOST", "envbox")
		router := NewTestRouter(logger, nil, nil, "test-host")

		req := httptest.NewRequest(http.MethodGet, "/api/health", nil)
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)

		var body map[string]any
		if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
			t.Fatalf("failed to decode response: %v", err)
		}
		if _, present := body["sshHost"]; present {
			t.Errorf("body.sshHost present (%q) with only RK_SSH_HOST set, want absent", body["sshHost"])
		}
	})

	t.Run("absent after the setting is cleared", func(t *testing.T) {
		isolateSettings(t)
		host := "uibox"
		if err := settings.SetSSHHost(&host); err != nil {
			t.Fatalf("SetSSHHost: %v", err)
		}
		if err := settings.SetSSHHost(nil); err != nil {
			t.Fatalf("SetSSHHost clear: %v", err)
		}
		router := NewTestRouter(logger, nil, nil, "test-host")

		req := httptest.NewRequest(http.MethodGet, "/api/health", nil)
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)

		var body map[string]any
		if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
			t.Fatalf("failed to decode response: %v", err)
		}
		if _, present := body["sshHost"]; present {
			t.Errorf("body.sshHost present (%q) after clear, want absent", body["sshHost"])
		}
	})
}

// The optional instanceName field (config.yaml `instance_name`, the display
// name override) rides the health response: present when set, absent (not
// empty-valued) when unset.
func TestHealthEndpointInstanceName(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(os.Stderr, nil))

	t.Run("present when set", func(t *testing.T) {
		isolateSettings(t)
		name := "my-box"
		if err := settings.SetInstanceName(&name); err != nil {
			t.Fatalf("SetInstanceName: %v", err)
		}
		router := NewTestRouter(logger, nil, nil, "test-host")

		req := httptest.NewRequest(http.MethodGet, "/api/health", nil)
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)

		var body map[string]any
		if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
			t.Fatalf("failed to decode response: %v", err)
		}
		if body["instanceName"] != "my-box" {
			t.Errorf("body.instanceName = %q, want %q", body["instanceName"], "my-box")
		}
		if body["hostname"] != "test-host" {
			t.Errorf("body.hostname = %q, want %q (real hostname stays)", body["hostname"], "test-host")
		}
	})

	t.Run("absent when unset", func(t *testing.T) {
		isolateSettings(t)
		router := NewTestRouter(logger, nil, nil, "test-host")

		req := httptest.NewRequest(http.MethodGet, "/api/health", nil)
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)

		var body map[string]any
		if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
			t.Fatalf("failed to decode response: %v", err)
		}
		if _, present := body["instanceName"]; present {
			t.Errorf("body.instanceName present (%q), want absent", body["instanceName"])
		}
	})
}

// The derived sshUser field (os/user.Current at startup) rides the health
// response beside sshHost: present when the lookup succeeded, absent (not
// empty-valued) when it failed — remote clients derive
// `${sshUser}@${location.hostname}` when the ssh_host setting is unset.
func TestHealthEndpointSSHUser(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(os.Stderr, nil))

	t.Run("present when derived", func(t *testing.T) {
		isolateSettings(t)
		s := &Server{logger: logger, hostname: "test-host"}
		s.SetSSHUser("sahil")
		router := s.buildRouter()

		req := httptest.NewRequest(http.MethodGet, "/api/health", nil)
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)

		var body map[string]any
		if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
			t.Fatalf("failed to decode response: %v", err)
		}
		if body["sshUser"] != "sahil" {
			t.Errorf("body.sshUser = %q, want %q", body["sshUser"], "sahil")
		}
	})

	t.Run("absent when the lookup failed (empty)", func(t *testing.T) {
		isolateSettings(t)
		router := NewTestRouter(logger, nil, nil, "test-host")

		req := httptest.NewRequest(http.MethodGet, "/api/health", nil)
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)

		var body map[string]any
		if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
			t.Fatalf("failed to decode response: %v", err)
		}
		if _, present := body["sshUser"]; present {
			t.Errorf("body.sshUser present (%q), want absent", body["sshUser"])
		}
	})
}

// The tunnel field advertises the WebSocket tunnel endpoint's capability: it
// is the daemon's listen port (the desktop's probe targets the tunnel at this
// host's own listen port), a JSON number seeded at startup so it always
// matches the bound listener, ALWAYS present on this build — its absence
// marks an older server.
func TestHealthEndpointTunnel(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(os.Stderr, nil))

	t.Run("carries the RK_PORT listen port as a number", func(t *testing.T) {
		isolateSettings(t)
		t.Setenv("RK_PORT", "3001")
		router := NewTestRouter(logger, nil, nil, "test-host")

		req := httptest.NewRequest(http.MethodGet, "/api/health", nil)
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)

		var body map[string]any
		if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
			t.Fatalf("failed to decode response: %v", err)
		}
		port, ok := body["tunnel"].(float64)
		if !ok {
			t.Fatalf("body.tunnel = %v (%T), want a JSON number", body["tunnel"], body["tunnel"])
		}
		if port != 3001 {
			t.Errorf("body.tunnel = %v, want 3001", port)
		}
		if _, present := body["forwardProxy"]; present {
			t.Errorf("body.forwardProxy present (%v), want absent", body["forwardProxy"])
		}
	})

	t.Run("always present, defaulting to the policy default", func(t *testing.T) {
		isolateSettings(t)
		t.Setenv("RK_PORT", "")
		router := NewTestRouter(logger, nil, nil, "test-host")

		req := httptest.NewRequest(http.MethodGet, "/api/health", nil)
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)

		var body map[string]any
		if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
			t.Fatalf("failed to decode response: %v", err)
		}
		port, ok := body["tunnel"].(float64)
		if !ok {
			t.Fatalf("body.tunnel absent or non-numeric (%v), want present", body["tunnel"])
		}
		if port != float64(portpolicy.DaemonDefault) {
			t.Errorf("body.tunnel = %v, want %d (policy default)", port, portpolicy.DaemonDefault)
		}
		if _, present := body["forwardProxy"]; present {
			t.Errorf("body.forwardProxy present (%v), want absent", body["forwardProxy"])
		}
	})
}
