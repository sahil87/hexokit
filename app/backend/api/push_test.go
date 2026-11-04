package api

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// isolatePush points state-home persistence at a throwaway HOME so push tests
// neither read nor clobber the developer's real ~/.local/state/hexokit files.
func isolatePush(t *testing.T) {
	t.Helper()
	t.Setenv("HOME", t.TempDir())
}

func TestPushVAPIDPublicKey_returnsKey(t *testing.T) {
	isolatePush(t)
	router := newTestRouter(&mockSessionFetcher{}, &mockTmuxOps{})

	req := httptest.NewRequest(http.MethodGet, "/api/push/vapid-public-key", nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body=%s", rec.Code, http.StatusOK, rec.Body.String())
	}
	var result map[string]string
	if err := json.NewDecoder(rec.Body).Decode(&result); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if result["key"] == "" {
		t.Error("expected non-empty 'key' field in vapid-public-key response")
	}
}

func TestPushSubscribe_storesValid(t *testing.T) {
	isolatePush(t)
	router := newTestRouter(&mockSessionFetcher{}, &mockTmuxOps{})

	body := `{"endpoint":"https://push.example/x","keys":{"p256dh":"p","auth":"a"}}`
	req := httptest.NewRequest(http.MethodPost, "/api/push/subscribe", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

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
}

func TestPushSubscribe_rejectsInvalid(t *testing.T) {
	isolatePush(t)
	router := newTestRouter(&mockSessionFetcher{}, &mockTmuxOps{})

	cases := []string{
		`not json`,
		`{"endpoint":"","keys":{"p256dh":"p","auth":"a"}}`,
		`{"endpoint":"https://e","keys":{"p256dh":"","auth":""}}`,
	}
	for _, body := range cases {
		req := httptest.NewRequest(http.MethodPost, "/api/push/subscribe", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)

		if rec.Code != http.StatusBadRequest {
			t.Errorf("body %q: status = %d, want %d", body, rec.Code, http.StatusBadRequest)
		}
	}
}

func TestNotify_emptyBodyRejected(t *testing.T) {
	isolatePush(t)
	router := newTestRouter(&mockSessionFetcher{}, &mockTmuxOps{})

	for _, body := range []string{`{}`, `{"body":""}`, `{"body":"   "}`} {
		req := httptest.NewRequest(http.MethodPost, "/api/notify", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)

		if rec.Code != http.StatusBadRequest {
			t.Errorf("body %q: status = %d, want %d", body, rec.Code, http.StatusBadRequest)
		}
	}
}

func TestNotify_noSubscriptionsReturnsSummary(t *testing.T) {
	isolatePush(t)
	s := &Server{
		logger:   slog.New(slog.NewTextHandler(io.Discard, nil)),
		sessions: &mockSessionFetcher{},
		tmux:     &mockTmuxOps{},
		hostname: "test-host",
	}
	s.initSSEHub()
	conn := newTestStateConn(s.sseHub, "notify-client", 16)
	s.sseHub.replayGlobalSlots(conn)
	t.Cleanup(func() { s.sseHub.dropStateConn(conn) })
	router := s.buildRouter()

	// No subscriptions stored → fan-out is a no-op, returns {sent:0, pruned:0}.
	req := httptest.NewRequest(http.MethodPost, "/api/notify", strings.NewReader(`{"body":"hi"}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body=%s", rec.Code, http.StatusOK, rec.Body.String())
	}
	var result struct {
		Sent   int `json:"sent"`
		Pruned int `json:"pruned"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&result); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if result.Sent != 0 || result.Pruned != 0 {
		t.Errorf("summary = %+v, want {0,0}", result)
	}

	frames := decodeEnvelopes(drainFrames(conn.ch))
	var payload notifyPayload
	found := false
	for _, frame := range frames {
		if rawStr(frame, "type") != "notify" {
			continue
		}
		found = true
		if err := json.Unmarshal(frame["data"], &payload); err != nil {
			t.Fatalf("decode notify event: %v", err)
		}
	}
	if !found {
		t.Fatal("connected state client received no notify event")
	}
	if payload.Title != "HexoKit" || payload.Body != "hi" || payload.URL != "" {
		t.Errorf("notify payload = %+v", payload)
	}
}
