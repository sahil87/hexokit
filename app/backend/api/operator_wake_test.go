package api

import (
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"rk/internal/cron"
)

// wakeServer builds a bare Server whose cron dir is a temp dir; the handler
// touches no tmux or sessions seam.
func wakeServer(t *testing.T) (*Server, string) {
	t.Helper()
	dir := filepath.Join(t.TempDir(), "cron")
	s := &Server{
		logger:    slog.New(slog.NewTextHandler(io.Discard, nil)),
		cronDirFn: func() (string, error) { return dir, nil },
		nowFn:     func() time.Time { return time.Unix(1_700_000_000, 0) },
	}
	return s, dir
}

func postWake(s *Server, body string) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/operator/wake", strings.NewReader(body))
	s.buildRouter().ServeHTTP(rec, req)
	return rec
}

func TestOperatorWake_WritesMarkerBeforeAcknowledging(t *testing.T) {
	s, dir := wakeServer(t)
	rec := postWake(s, `{"server":"work"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	var got map[string]string
	if err := json.NewDecoder(rec.Body).Decode(&got); err != nil {
		t.Fatal(err)
	}
	if got["server"] != "work" || got["reason"] != "manual" || len(got) != 2 {
		t.Errorf("receipt = %v, want {server:work, reason:manual}", got)
	}
	m, ok, err := cron.ReadWakeMarker(dir, "work")
	if err != nil || !ok || m.Reason != "manual" || m.At != 1_700_000_000 {
		t.Fatalf("marker = %+v ok=%v err=%v", m, ok, err)
	}
	if fi, _ := os.Stat(filepath.Join(dir, "work.wake")); fi.Mode().Perm() != 0o600 {
		t.Errorf("marker mode = %v, want 0600", fi.Mode().Perm())
	}
}

func TestOperatorWake_CarriesReason(t *testing.T) {
	s, dir := wakeServer(t)
	rec := postWake(s, `{"server":"work","reason":"  new note on pr-41 "}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d; body=%s", rec.Code, rec.Body.String())
	}
	if m, ok, _ := cron.ReadWakeMarker(dir, "work"); !ok || m.Reason != "new note on pr-41" {
		t.Errorf("marker = %+v ok=%v", m, ok)
	}
	if !strings.Contains(rec.Body.String(), `"reason":"new note on pr-41"`) {
		t.Errorf("receipt = %s", rec.Body.String())
	}
}

func TestOperatorWake_BadInputIs400AndWritesNothing(t *testing.T) {
	cases := map[string]string{
		"bad server name": `{"server":"bad name!"}`,
		"missing server":  `{}`,
		"path server":     `{"server":"../x"}`,
		"newline reason":  `{"server":"work","reason":"a\nb"}`,
		"long reason":     `{"server":"work","reason":"` + strings.Repeat("x", cron.MaxWakeReasonRunes+1) + `"}`,
		"malformed json":  `{"server":`,
		"empty body":      ``,
	}
	for name, body := range cases {
		t.Run(name, func(t *testing.T) {
			s, dir := wakeServer(t)
			rec := postWake(s, body)
			if rec.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, want 400; body=%s", rec.Code, rec.Body.String())
			}
			var e map[string]string
			if err := json.NewDecoder(rec.Body).Decode(&e); err != nil || e["error"] == "" {
				t.Errorf("error body = %q (%v), want the repo's {error} shape", rec.Body.String(), err)
			}
			if _, err := os.Stat(dir); !os.IsNotExist(err) {
				entries, _ := os.ReadDir(dir)
				t.Errorf("a rejected request touched the cron dir: %v", entries)
			}
		})
	}
}

func TestOperatorWake_WriteFailureIs500(t *testing.T) {
	s, dir := wakeServer(t)
	if err := os.MkdirAll(filepath.Dir(dir), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(dir, []byte("not a dir"), 0o600); err != nil {
		t.Fatal(err)
	}
	if rec := postWake(s, `{"server":"work"}`); rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500; body=%s", rec.Code, rec.Body.String())
	}

	s.cronDirFn = func() (string, error) { return "", errors.New("no state home") }
	if rec := postWake(s, `{"server":"work"}`); rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500 for an unresolvable cron dir", rec.Code)
	}
}

func TestOperatorWake_OnlyPostIsRouted(t *testing.T) {
	s, dir := wakeServer(t)
	for _, method := range []string{http.MethodGet, http.MethodPut, http.MethodDelete, http.MethodPatch} {
		rec := httptest.NewRecorder()
		s.buildRouter().ServeHTTP(rec, httptest.NewRequest(method, "/api/operator/wake?server=work", strings.NewReader(`{"server":"work"}`)))
		if rec.Code != http.StatusMethodNotAllowed && rec.Code != http.StatusNotFound {
			t.Errorf("%s status = %d, want 404/405", method, rec.Code)
		}
	}
	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Error("a non-POST request wrote a marker")
	}
}
