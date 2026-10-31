package api

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"rk/internal/tmux"
)

// serversTmuxMock extends mockTmuxOps with configurable ListServers/ListSessions
// for the /api/servers list handler tests.
type serversTmuxMock struct {
	mockTmuxOps
	servers  []string
	sessions map[string][]tmux.SessionInfo
	errs     map[string]error
}

func (m *serversTmuxMock) ListServers(ctx context.Context) ([]string, error) {
	return m.servers, nil
}

func (m *serversTmuxMock) ListSessions(ctx context.Context, server string) ([]tmux.SessionInfo, error) {
	if err, ok := m.errs[server]; ok && err != nil {
		return nil, err
	}
	return m.sessions[server], nil
}

func TestHandleServersList_Empty(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(os.Stderr, nil))
	mock := &serversTmuxMock{servers: nil}
	router := NewTestRouter(logger, nil, mock, "test-host")

	req := httptest.NewRequest("GET", "/api/servers", nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != 200 {
		t.Fatalf("status = %d, want 200", rec.Code)
	}

	var got []serverInfo
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(got) != 0 {
		t.Fatalf("len = %d, want 0. body=%s", len(got), rec.Body.String())
	}
	// Confirm it's `[]` not `null` in the wire format
	if rec.Body.String() != "[]\n" && rec.Body.String() != "[]" {
		t.Fatalf("body = %q, want [] (not null)", rec.Body.String())
	}
}

func TestHandleServersList_SingleServer(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(os.Stderr, nil))
	mock := &serversTmuxMock{
		servers: []string{"default"},
		sessions: map[string][]tmux.SessionInfo{
			"default": {
				{Name: "a"}, {Name: "b"}, {Name: "c"}, {Name: "d"},
			},
		},
	}
	router := NewTestRouter(logger, nil, mock, "test-host")

	req := httptest.NewRequest("GET", "/api/servers", nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != 200 {
		t.Fatalf("status = %d, want 200", rec.Code)
	}

	var got []serverInfo
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("len = %d, want 1", len(got))
	}
	if got[0].Name != "default" || got[0].SessionCount != 4 {
		t.Fatalf("got %+v, want {default 4}", got[0])
	}
}

func TestHandleServersList_MultipleWithOneFailure(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(os.Stderr, nil))
	mock := &serversTmuxMock{
		servers: []string{"default", "work", "broken"},
		sessions: map[string][]tmux.SessionInfo{
			"default": {{Name: "s1"}, {Name: "s2"}, {Name: "s3"}},
			"work":    {{Name: "s1"}, {Name: "s2"}},
		},
		errs: map[string]error{
			"broken": errors.New("no server running"),
		},
	}
	router := NewTestRouter(logger, nil, mock, "test-host")

	req := httptest.NewRequest("GET", "/api/servers", nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != 200 {
		t.Fatalf("status = %d, want 200 (per-server failure must not surface as 5xx). body=%s", rec.Code, rec.Body.String())
	}

	var got []serverInfo
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(got) != 3 {
		t.Fatalf("len = %d, want 3", len(got))
	}

	// Response is sorted by name: broken, default, work
	byName := map[string]int{}
	for _, e := range got {
		byName[e.Name] = e.SessionCount
	}
	if byName["default"] != 3 {
		t.Errorf("default count = %d, want 3", byName["default"])
	}
	if byName["work"] != 2 {
		t.Errorf("work count = %d, want 2", byName["work"])
	}
	if byName["broken"] != 0 {
		t.Errorf("broken count = %d, want 0 (error -> 0)", byName["broken"])
	}
}

func TestHandleServersList_WindowCountSummation(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(os.Stderr, nil))
	// The mock returns what parseSessions would KEEP — group copies are
	// already filtered upstream, so the handler sums exactly these.
	mock := &serversTmuxMock{
		servers: []string{"default", "work", "broken"},
		sessions: map[string][]tmux.SessionInfo{
			"default": {{Name: "s1", Windows: 3}, {Name: "s2", Windows: 2}},
			"work":    {{Name: "s1", Windows: 1}},
		},
		errs: map[string]error{
			"broken": errors.New("no server running"),
		},
	}
	router := NewTestRouter(logger, nil, mock, "test-host")

	req := httptest.NewRequest("GET", "/api/servers", nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != 200 {
		t.Fatalf("status = %d, want 200 (per-server failure must not surface as 5xx). body=%s", rec.Code, rec.Body.String())
	}

	var got []serverInfo
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(got) != 3 {
		t.Fatalf("len = %d, want 3", len(got))
	}

	byName := map[string]serverInfo{}
	for _, e := range got {
		byName[e.Name] = e
	}
	if byName["default"].WindowCount != 5 {
		t.Errorf("default windowCount = %d, want 5 (3+2)", byName["default"].WindowCount)
	}
	if byName["work"].WindowCount != 1 {
		t.Errorf("work windowCount = %d, want 1", byName["work"].WindowCount)
	}
	if byName["broken"].WindowCount != 0 {
		t.Errorf("broken windowCount = %d, want 0 (error -> 0)", byName["broken"].WindowCount)
	}
	// sessionCount is kept alongside windowCount (no rename).
	if byName["default"].SessionCount != 2 {
		t.Errorf("default sessionCount = %d, want 2", byName["default"].SessionCount)
	}

	// The wire format carries the windowCount key explicitly.
	if !strings.Contains(rec.Body.String(), "\"windowCount\":5") {
		t.Errorf("body missing windowCount:5. body=%s", rec.Body.String())
	}
}

// The test-socket hide filter was DELETED: /api/servers now surfaces EVERY
// tmux server, including leaked rk-test-* orphans (and the unified
// rk-test-e2e-* Playwright servers). `rk mux reap` is the sole mechanism that
// keeps this list clean. The former hide-assertion is inverted here — all
// servers must be returned, sorted alphabetically.
func TestHandleServersList_ReturnsAllServersIncludingTestSockets(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(os.Stderr, nil))
	mock := &serversTmuxMock{
		servers: []string{
			"default",
			"Some",
			"rk-test-unit-12345-67890",         // shown (was hidden)
			"rk-test-relay-12345-67890",        // shown (was hidden)
			"rk-test-tmuxctl-12345-67890",      // shown (was hidden)
			"rk-test-daemon-12345-67890",       // shown (was hidden)
			"rk-test-e2e",                      // shown (persistent harness)
			"rk-test-e2e-coupling-12345-67890", // shown (Playwright secondary)
			"rk-test-e2e-multi-12345-67890",    // shown (Playwright secondary)
		},
		sessions: map[string][]tmux.SessionInfo{},
	}
	router := NewTestRouter(logger, nil, mock, "test-host")

	req := httptest.NewRequest("GET", "/api/servers", nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	var got []serverInfo
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	gotNames := make([]string, len(got))
	for i, e := range got {
		gotNames[i] = e.Name
	}
	// Every server is returned, including the rk-test-* orphans, sorted by name.
	want := []string{
		"Some",
		"default",
		"rk-test-daemon-12345-67890",
		"rk-test-e2e",
		"rk-test-e2e-coupling-12345-67890",
		"rk-test-e2e-multi-12345-67890",
		"rk-test-relay-12345-67890",
		"rk-test-tmuxctl-12345-67890",
		"rk-test-unit-12345-67890",
	}
	if len(gotNames) != len(want) {
		t.Fatalf("got %v, want %v", gotNames, want)
	}
	for i, name := range want {
		if gotNames[i] != name {
			t.Errorf("got[%d] = %q, want %q (full: %v)", i, gotNames[i], name, gotNames)
		}
	}
}

func intPtr(n int) *int { return &n }

func TestHandleServersList_IncludesRankField(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(os.Stderr, nil))
	mock := &serversTmuxMock{
		servers: []string{"work", "default"},
		sessions: map[string][]tmux.SessionInfo{
			"work":    {{Name: "s1"}},
			"default": {{Name: "s1"}},
		},
	}
	// "default" is ranked 0; "work" has no rank (nil).
	mock.readServerMarksByServer = map[string]tmux.ServerMarks{"default": {Rank: intPtr(0)}}

	router := NewTestRouter(logger, nil, mock, "test-host")
	req := httptest.NewRequest("GET", "/api/servers", nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != 200 {
		t.Fatalf("status = %d, want 200. body=%s", rec.Code, rec.Body.String())
	}
	var got []serverInfo
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	// Array stays alphabetical (asserted contract): default, work.
	if len(got) != 2 || got[0].Name != "default" || got[1].Name != "work" {
		t.Fatalf("got %+v, want [default, work] alphabetical", got)
	}
	if got[0].Rank == nil || *got[0].Rank != 0 {
		t.Errorf("default rank = %v, want 0", got[0].Rank)
	}
	if got[1].Rank != nil {
		t.Errorf("work rank = %v, want nil (unranked)", got[1].Rank)
	}
}

// A marks-read failure zeroes ALL mark fields for the entry (rank: null,
// flags false) while the request still answers 200 — the no-5xx stance.
func TestHandleServersList_RankReadErrorYieldsNullRank(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(os.Stderr, nil))
	mock := &serversTmuxMock{
		servers:  []string{"broken"},
		sessions: map[string][]tmux.SessionInfo{"broken": {{Name: "s1"}}},
	}
	mock.readServerMarksErrByServer = map[string]error{"broken": errors.New("boom")}

	router := NewTestRouter(logger, nil, mock, "test-host")
	req := httptest.NewRequest("GET", "/api/servers", nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != 200 {
		t.Fatalf("status = %d, want 200 (marks read failure must not surface as 5xx)", rec.Code)
	}
	var got []serverInfo
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(got) != 1 || got[0].Rank != nil {
		t.Fatalf("got %+v, want rank nil on read error", got)
	}
	if got[0].Ephemeral || got[0].Protected || got[0].Managed {
		t.Errorf("got %+v, want all flags false on marks read error", got[0])
	}
	if got[0].SessionCount != 1 {
		t.Errorf("sessionCount = %d, want 1 (ListSessions is a separate read)", got[0].SessionCount)
	}
}

func TestHandleServersList_IncludesEphemeralField(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(os.Stderr, nil))
	mock := &serversTmuxMock{
		servers: []string{"work", "default"},
		sessions: map[string][]tmux.SessionInfo{
			"work":    {{Name: "s1"}},
			"default": {{Name: "s1"}},
		},
	}
	mock.readServerMarksByServer = map[string]tmux.ServerMarks{"work": {Ephemeral: true}}

	router := NewTestRouter(logger, nil, mock, "test-host")
	req := httptest.NewRequest("GET", "/api/servers", nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != 200 {
		t.Fatalf("status = %d, want 200. body=%s", rec.Code, rec.Body.String())
	}
	var got []serverInfo
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	// Array stays alphabetical (asserted contract): default, work.
	if len(got) != 2 || got[0].Name != "default" || got[1].Name != "work" {
		t.Fatalf("got %+v, want [default, work] alphabetical", got)
	}
	if got[0].Ephemeral {
		t.Errorf("default ephemeral = true, want false (unmarked)")
	}
	if !got[1].Ephemeral {
		t.Errorf("work ephemeral = false, want true (marked)")
	}
	if !strings.Contains(rec.Body.String(), "\"ephemeral\":true") {
		t.Errorf("body missing ephemeral:true. body=%s", rec.Body.String())
	}
}

func TestHandleServersList_EphemeralReadErrorYieldsFalse(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(os.Stderr, nil))
	mock := &serversTmuxMock{
		servers:  []string{"broken"},
		sessions: map[string][]tmux.SessionInfo{"broken": {{Name: "s1"}}},
	}
	mock.readServerMarksErrByServer = map[string]error{"broken": errors.New("boom")}

	router := NewTestRouter(logger, nil, mock, "test-host")
	req := httptest.NewRequest("GET", "/api/servers", nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != 200 {
		t.Fatalf("status = %d, want 200 (ephemeral read failure must not surface as 5xx)", rec.Code)
	}
	var got []serverInfo
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(got) != 1 || got[0].Ephemeral {
		t.Fatalf("got %+v, want ephemeral false on read error", got)
	}
}

func TestHandleServerOrderPost_WritesRanksInOrder(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(os.Stderr, nil))
	mock := &serversTmuxMock{}

	router := NewTestRouter(logger, nil, mock, "test-host")
	body := `{"order":["a","b","c"]}`
	req := httptest.NewRequest("POST", "/api/servers/order", strings.NewReader(body))
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != 200 {
		t.Fatalf("status = %d, want 200. body=%s", rec.Code, rec.Body.String())
	}
	if len(mock.setServerRankCalls) != 3 {
		t.Fatalf("SetServerRank called %d times, want 3: %+v", len(mock.setServerRankCalls), mock.setServerRankCalls)
	}
	want := []struct {
		Server string
		Rank   int
	}{{"a", 0}, {"b", 1}, {"c", 2}}
	for i, c := range mock.setServerRankCalls {
		if c != want[i] {
			t.Errorf("call[%d] = %+v, want %+v", i, c, want[i])
		}
	}
}

func TestHandleServerOrderPost_InvalidNameRejected(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(os.Stderr, nil))
	mock := &serversTmuxMock{}

	router := NewTestRouter(logger, nil, mock, "test-host")
	// A name with a forbidden character fails ValidateServerName.
	body := `{"order":["ok","bad name!"]}`
	req := httptest.NewRequest("POST", "/api/servers/order", strings.NewReader(body))
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != 400 {
		t.Fatalf("status = %d, want 400 for invalid server name", rec.Code)
	}
	if len(mock.setServerRankCalls) != 0 {
		t.Errorf("SetServerRank was called %d times, want 0 (validation before any write)", len(mock.setServerRankCalls))
	}
}

func TestHandleServerOrderPost_DuplicateNameRejected(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(os.Stderr, nil))
	mock := &serversTmuxMock{}

	router := NewTestRouter(logger, nil, mock, "test-host")
	// A duplicated name would assign multiple ranks (last wins) — reject up front.
	body := `{"order":["srv-a","srv-b","srv-a"]}`
	req := httptest.NewRequest("POST", "/api/servers/order", strings.NewReader(body))
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != 400 {
		t.Fatalf("status = %d, want 400 for duplicate server name", rec.Code)
	}
	if len(mock.setServerRankCalls) != 0 {
		t.Errorf("SetServerRank was called %d times, want 0 (validation before any write)", len(mock.setServerRankCalls))
	}
}

func TestHandleServerOrderPost_MalformedBodyRejected(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(os.Stderr, nil))
	mock := &serversTmuxMock{}

	router := NewTestRouter(logger, nil, mock, "test-host")
	req := httptest.NewRequest("POST", "/api/servers/order", strings.NewReader(`{"order": "not-an-array"}`))
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != 400 {
		t.Fatalf("status = %d, want 400 for malformed body", rec.Code)
	}
}

func TestHandleServersList_SortedAlphabetically(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(os.Stderr, nil))
	mock := &serversTmuxMock{
		servers: []string{"zebra", "alpha", "mike"},
		sessions: map[string][]tmux.SessionInfo{
			"zebra": {{Name: "s1"}},
			"alpha": {{Name: "s1"}},
			"mike":  {{Name: "s1"}},
		},
	}
	router := NewTestRouter(logger, nil, mock, "test-host")

	req := httptest.NewRequest("GET", "/api/servers", nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	var got []serverInfo
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	want := []string{"alpha", "mike", "zebra"}
	for i, e := range got {
		if e.Name != want[i] {
			t.Errorf("got[%d].Name = %q, want %q", i, e.Name, want[i])
		}
	}
}

// TestHandleServerKill_NotifiesAuditedKill verifies the snapshotter seam: the
// kill handler invokes the wired notifier with the server name before the
// audited KillServer, and an unwired (nil) notifier leaves the path working.
func TestHandleServerKill_NotifiesAuditedKill(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(os.Stderr, nil))
	mock := &serversTmuxMock{}

	s := &Server{logger: logger, tmux: mock, hostname: "test-host"}
	var notified []string
	s.SetServerKillNotifier(func(server string) { notified = append(notified, server) })
	router := s.buildRouter()

	req := httptest.NewRequest("POST", "/api/servers/kill", strings.NewReader(`{"name":"kit"}`))
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != 200 {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if len(notified) != 1 || notified[0] != "kit" {
		t.Errorf("notifier calls = %v, want [kit]", notified)
	}

	// Invalid server name is rejected BEFORE the notifier fires.
	notified = nil
	req = httptest.NewRequest("POST", "/api/servers/kill", strings.NewReader(`{"name":"bad/name"}`))
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != 400 {
		t.Fatalf("status = %d, want 400 for invalid name", rec.Code)
	}
	if len(notified) != 0 {
		t.Errorf("notifier fired for invalid name: %v", notified)
	}

	// Unwired notifier: the kill path still works.
	router = NewTestRouter(logger, nil, &serversTmuxMock{}, "test-host")
	req = httptest.NewRequest("POST", "/api/servers/kill", strings.NewReader(`{"name":"kit"}`))
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != 200 {
		t.Fatalf("unwired notifier: status = %d, want 200", rec.Code)
	}
}

// TestHandleServerKill_ProtectedRefusedWithoutForce covers the kill guard
// matrix: the daemon (derived) and an option-marked server refuse without
// force (409, structured body, no audited-kill notify), proceed with force,
// and a normal server is unaffected.
func TestHandleServerKill_ProtectedRefusedWithoutForce(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(os.Stderr, nil))
	mock := &serversTmuxMock{}
	mock.isProtectedByServer = map[string]bool{"vault": true}

	s := &Server{logger: logger, tmux: mock, hostname: "test-host"}
	var notified []string
	s.SetServerKillNotifier(func(server string) { notified = append(notified, server) })
	router := s.buildRouter()

	// Daemon, no force → 409 with the structured protected flag, no notify.
	req := httptest.NewRequest("POST", "/api/servers/kill", strings.NewReader(`{"name":"rk-daemon"}`))
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != 409 {
		t.Fatalf("daemon no-force: status = %d, want 409. body=%s", rec.Code, rec.Body.String())
	}
	var body map[string]interface{}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if body["protected"] != true {
		t.Errorf("daemon no-force: protected = %v, want true. body=%s", body["protected"], rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "/api/restart") {
		t.Errorf("daemon no-force: error must name the restart alternative. body=%s", rec.Body.String())
	}
	if len(notified) != 0 {
		t.Errorf("notifier fired for a refused kill: %v (409 must precede the audit)", notified)
	}

	// Option-marked server, no force → 409.
	req = httptest.NewRequest("POST", "/api/servers/kill", strings.NewReader(`{"name":"vault"}`))
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != 409 {
		t.Fatalf("marked no-force: status = %d, want 409. body=%s", rec.Code, rec.Body.String())
	}
	if len(notified) != 0 {
		t.Errorf("notifier fired for a refused kill: %v", notified)
	}

	// Daemon with force → kill proceeds (audited).
	req = httptest.NewRequest("POST", "/api/servers/kill", strings.NewReader(`{"name":"rk-daemon","force":true}`))
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != 200 {
		t.Fatalf("daemon force: status = %d, want 200. body=%s", rec.Code, rec.Body.String())
	}
	if len(notified) != 1 || notified[0] != "rk-daemon" {
		t.Errorf("notifier calls = %v, want [rk-daemon]", notified)
	}

	// Option-marked server with force → kill proceeds.
	req = httptest.NewRequest("POST", "/api/servers/kill", strings.NewReader(`{"name":"vault","force":true}`))
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != 200 {
		t.Fatalf("marked force: status = %d, want 200. body=%s", rec.Code, rec.Body.String())
	}

	// Normal server, no force → unchanged path (200, audited).
	req = httptest.NewRequest("POST", "/api/servers/kill", strings.NewReader(`{"name":"kit"}`))
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != 200 {
		t.Fatalf("normal no-force: status = %d, want 200. body=%s", rec.Code, rec.Body.String())
	}
}

func TestHandleServersList_IncludesProtectedField(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(os.Stderr, nil))
	mock := &serversTmuxMock{
		servers: []string{"work", "rk-daemon"},
		sessions: map[string][]tmux.SessionInfo{
			"work":      {{Name: "s1"}},
			"rk-daemon": {{Name: "s1"}},
		},
	}
	mock.readServerMarksByServer = map[string]tmux.ServerMarks{"work": {Protected: true}}

	router := NewTestRouter(logger, nil, mock, "test-host")
	req := httptest.NewRequest("GET", "/api/servers", nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != 200 {
		t.Fatalf("status = %d, want 200. body=%s", rec.Code, rec.Body.String())
	}
	var got []serverInfo
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	byName := map[string]serverInfo{}
	for _, e := range got {
		byName[e.Name] = e
	}
	if !byName["work"].Protected {
		t.Errorf("work protected = false, want true (marked)")
	}
	if !byName["rk-daemon"].Protected {
		t.Errorf("rk-daemon protected = false, want true (derived)")
	}
	if !strings.Contains(rec.Body.String(), "\"protected\":true") {
		t.Errorf("body missing protected:true. body=%s", rec.Body.String())
	}
}

func TestHandleServersList_ProtectedReadErrorYieldsFalse(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(os.Stderr, nil))
	mock := &serversTmuxMock{
		servers:  []string{"broken"},
		sessions: map[string][]tmux.SessionInfo{"broken": {{Name: "s1"}}},
	}
	mock.readServerMarksErrByServer = map[string]error{"broken": errors.New("boom")}

	router := NewTestRouter(logger, nil, mock, "test-host")
	req := httptest.NewRequest("GET", "/api/servers", nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != 200 {
		t.Fatalf("status = %d, want 200 (protected read failure must not surface as 5xx)", rec.Code)
	}
	var got []serverInfo
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(got) != 1 || got[0].Protected {
		t.Fatalf("got %+v, want protected false on read error", got)
	}
}

func TestHandleServerProtect_SetAndUnset(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(os.Stderr, nil))
	mock := &serversTmuxMock{}

	router := NewTestRouter(logger, nil, mock, "test-host")

	req := httptest.NewRequest("POST", "/api/servers/protect", strings.NewReader(`{"name":"myserver","protected":true}`))
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != 200 {
		t.Fatalf("protect: status = %d, want 200. body=%s", rec.Code, rec.Body.String())
	}

	req = httptest.NewRequest("POST", "/api/servers/protect", strings.NewReader(`{"name":"myserver","protected":false}`))
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != 200 {
		t.Fatalf("unprotect: status = %d, want 200. body=%s", rec.Code, rec.Body.String())
	}

	if len(mock.markProtectedCalls) != 2 {
		t.Fatalf("mark calls = %+v, want 2", mock.markProtectedCalls)
	}
	if mock.markProtectedCalls[0].Server != "myserver" || !mock.markProtectedCalls[0].Protected {
		t.Errorf("call[0] = %+v, want {myserver true}", mock.markProtectedCalls[0])
	}
	if mock.markProtectedCalls[1].Server != "myserver" || mock.markProtectedCalls[1].Protected {
		t.Errorf("call[1] = %+v, want {myserver false}", mock.markProtectedCalls[1])
	}
}

// TestHandleServerWake verifies the CLI-facing wake endpoint: a valid name
// wakes the SSE hub's derive tick for that server (a fresh poll pass runs
// promptly), while an invalid name or malformed body is a 400 that never
// touches the hub. The endpoint issues no tmux calls in any branch.
func TestHandleServerWake(t *testing.T) {
	t.Run("valid name wakes the hub", func(t *testing.T) {
		server, tracker := newWakeSeamServer(t, &mockTmuxOps{})
		before := tracker.count.Load()
		router := server.buildRouter()
		req := httptest.NewRequest("POST", "/api/servers/wake", strings.NewReader(`{"name":"default"}`))
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		if rec.Code != 200 {
			t.Fatalf("status = %d, want 200. body=%s", rec.Code, rec.Body.String())
		}
		expectWake(t, tracker, before, "server wake")
	})

	t.Run("invalid name rejected without wake", func(t *testing.T) {
		server, tracker := newWakeSeamServer(t, &mockTmuxOps{})
		before := tracker.count.Load()
		router := server.buildRouter()
		req := httptest.NewRequest("POST", "/api/servers/wake", strings.NewReader(`{"name":"bad/name"}`))
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		if rec.Code != 400 {
			t.Fatalf("status = %d, want 400 for invalid name. body=%s", rec.Code, rec.Body.String())
		}
		expectNoWake(t, tracker, before, "invalid name")
	})

	t.Run("malformed body rejected without wake", func(t *testing.T) {
		server, tracker := newWakeSeamServer(t, &mockTmuxOps{})
		before := tracker.count.Load()
		router := server.buildRouter()
		req := httptest.NewRequest("POST", "/api/servers/wake", strings.NewReader(`{`))
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		if rec.Code != 400 {
			t.Fatalf("status = %d, want 400 for malformed body. body=%s", rec.Code, rec.Body.String())
		}
		expectNoWake(t, tracker, before, "malformed body")
	})

	// A previously polled server keeps accepting wakes while momentarily
	// client-less (its h.wakes entry exists — wakeChannel created it): the
	// wake must stay PENDING so it fires on resubscribe rather than being
	// lost to a brief socket reconnect.
	t.Run("ever-polled server pends the wake while client-less", func(t *testing.T) {
		server, _ := newWakeSeamServer(t, &mockTmuxOps{})
		// Simulate "polled before, no clients now": seed the entry the poll
		// loop's wakeChannel would have created, with no client subscribed.
		server.sseHub.wakeMu.Lock()
		server.sseHub.wakes["idle-server"] = make(chan struct{})
		server.sseHub.wakeMu.Unlock()

		router := server.buildRouter()
		req := httptest.NewRequest("POST", "/api/servers/wake", strings.NewReader(`{"name":"idle-server"}`))
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		if rec.Code != 200 {
			t.Fatalf("status = %d, want 200. body=%s", rec.Code, rec.Body.String())
		}

		server.sseHub.wakeMu.Lock()
		ch, ok := server.sseHub.wakes["idle-server"]
		server.sseHub.wakeMu.Unlock()
		if !ok {
			t.Fatal("the ever-polled server's wake entry disappeared")
		}
		select {
		case <-ch:
			// closed — the wake is pending for the next poll pass
		default:
			t.Error("wake channel not closed — the wake was dropped instead of pended")
		}
	})

	// The endpoint accepts any syntactically valid name from out-of-process
	// callers, so a name with no subscribers must be dropped BEFORE it
	// allocates a h.wakes entry — nothing ever reaps entries for servers
	// outside the poll set, and retained unknown names would grow unbounded.
	t.Run("unsubscribed name allocates no wake entry", func(t *testing.T) {
		server, tracker := newWakeSeamServer(t, &mockTmuxOps{})
		before := tracker.count.Load()
		router := server.buildRouter()
		req := httptest.NewRequest("POST", "/api/servers/wake", strings.NewReader(`{"name":"ghost-server"}`))
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		if rec.Code != 200 {
			t.Fatalf("status = %d, want 200 (the drop is silent). body=%s", rec.Code, rec.Body.String())
		}
		server.sseHub.wakeMu.Lock()
		_, retained := server.sseHub.wakes["ghost-server"]
		server.sseHub.wakeMu.Unlock()
		if retained {
			t.Error("h.wakes retained an entry for an unsubscribed server name")
		}
		expectNoWake(t, tracker, before, "unsubscribed name")
	})
}

func TestHandleServerProtect_DaemonRejected(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(os.Stderr, nil))
	mock := &serversTmuxMock{}

	router := NewTestRouter(logger, nil, mock, "test-host")
	req := httptest.NewRequest("POST", "/api/servers/protect", strings.NewReader(`{"name":"rk-daemon","protected":false}`))
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != 400 {
		t.Fatalf("status = %d, want 400 (derived protection is not togglable). body=%s", rec.Code, rec.Body.String())
	}
	if len(mock.markProtectedCalls) != 0 {
		t.Errorf("mark calls = %+v, want none for the daemon", mock.markProtectedCalls)
	}
}

func TestHandleServerProtect_InvalidNameRejected(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(os.Stderr, nil))
	mock := &serversTmuxMock{}

	router := NewTestRouter(logger, nil, mock, "test-host")
	req := httptest.NewRequest("POST", "/api/servers/protect", strings.NewReader(`{"name":"bad/name","protected":true}`))
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != 400 {
		t.Fatalf("status = %d, want 400 for invalid name", rec.Code)
	}
	if len(mock.markProtectedCalls) != 0 {
		t.Errorf("mark calls = %+v, want none (validation before any write)", mock.markProtectedCalls)
	}
}

func TestHandleServerProtect_WriteFailureSurfaces500(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(os.Stderr, nil))
	mock := &serversTmuxMock{}
	mock.markProtectedErr = errors.New("no server running")

	router := NewTestRouter(logger, nil, mock, "test-host")
	req := httptest.NewRequest("POST", "/api/servers/protect", strings.NewReader(`{"name":"gone","protected":true}`))
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != 500 {
		t.Fatalf("status = %d, want 500 on option write failure (not silent success)", rec.Code)
	}
}

func TestHandleServersList_IncludesManagedField(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(os.Stderr, nil))
	mock := &serversTmuxMock{
		servers: []string{"work", "rk-daemon", "ext"},
		sessions: map[string][]tmux.SessionInfo{
			"work":      {{Name: "s1"}},
			"rk-daemon": {{Name: "s1"}},
			"ext":       {{Name: "s1"}},
		},
	}
	mock.readServerMarksByServer = map[string]tmux.ServerMarks{"work": {Managed: true}}

	router := NewTestRouter(logger, nil, mock, "test-host")
	req := httptest.NewRequest("GET", "/api/servers", nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != 200 {
		t.Fatalf("status = %d, want 200. body=%s", rec.Code, rec.Body.String())
	}
	var got []serverInfo
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	byName := map[string]serverInfo{}
	for _, e := range got {
		byName[e.Name] = e
	}
	if !byName["work"].Managed {
		t.Errorf("work managed = false, want true (marked)")
	}
	if !byName["rk-daemon"].Managed {
		t.Errorf("rk-daemon managed = false, want true (derived)")
	}
	if byName["ext"].Managed {
		t.Errorf("ext managed = true, want false (unmarked)")
	}
	if !strings.Contains(rec.Body.String(), "\"managed\":true") {
		t.Errorf("body missing managed:true. body=%s", rec.Body.String())
	}
}

func TestHandleServersList_ManagedReadErrorYieldsFalse(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(os.Stderr, nil))
	mock := &serversTmuxMock{
		servers:  []string{"broken"},
		sessions: map[string][]tmux.SessionInfo{"broken": {{Name: "s1"}}},
	}
	mock.readServerMarksErrByServer = map[string]error{"broken": errors.New("boom")}

	router := NewTestRouter(logger, nil, mock, "test-host")
	req := httptest.NewRequest("GET", "/api/servers", nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != 200 {
		t.Fatalf("status = %d, want 200 (managed read failure must not surface as 5xx)", rec.Code)
	}
	var got []serverInfo
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(got) != 1 || got[0].Managed {
		t.Fatalf("got %+v, want managed false on read error", got)
	}
}

// TestHandleServersList_DaemonMarksReadErrorKeepsDerivedFlags: the rk-daemon
// production server's protected/managed flags come from derivation, not the
// marks read, so they hold even when ReadServerMarks fails (rank and ephemeral
// still zero out — those have no derivation).
func TestHandleServersList_DaemonMarksReadErrorKeepsDerivedFlags(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(os.Stderr, nil))
	mock := &serversTmuxMock{
		servers:  []string{"rk-daemon"},
		sessions: map[string][]tmux.SessionInfo{"rk-daemon": {{Name: "s1"}}},
	}
	mock.readServerMarksErrByServer = map[string]error{"rk-daemon": errors.New("boom")}

	router := NewTestRouter(logger, nil, mock, "test-host")
	req := httptest.NewRequest("GET", "/api/servers", nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != 200 {
		t.Fatalf("status = %d, want 200 (marks read failure must not surface as 5xx)", rec.Code)
	}
	var got []serverInfo
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("got %+v, want one entry", got)
	}
	if !got[0].Protected {
		t.Errorf("rk-daemon protected = false, want true (derived, survives marks failure)")
	}
	if !got[0].Managed {
		t.Errorf("rk-daemon managed = false, want true (derived, survives marks failure)")
	}
	if got[0].Rank != nil || got[0].Ephemeral {
		t.Errorf("got %+v, want rank nil + ephemeral false on marks failure", got[0])
	}
}

// TestHandleServerAdopt_Success: an unmarked server is stamped, then its conf
// is sourced — mark before reload — the legacy sweep runs, and the response
// reports status ok.
func TestHandleServerAdopt_Success(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(os.Stderr, nil))
	mock := &serversTmuxMock{}
	swept := stubAdoptMigrateLegacy(t, false)

	router := NewTestRouter(logger, nil, mock, "test-host")
	req := httptest.NewRequest("POST", "/api/servers/adopt", strings.NewReader(`{"name":"ext"}`))
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != 200 {
		t.Fatalf("status = %d, want 200. body=%s", rec.Code, rec.Body.String())
	}
	var body map[string]string
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if body["status"] != "ok" {
		t.Errorf("status = %q, want ok. body=%s", body["status"], rec.Body.String())
	}
	if len(mock.markManagedCalls) != 1 || mock.markManagedCalls[0] != "ext" {
		t.Errorf("mark calls = %v, want one mark of ext", mock.markManagedCalls)
	}
	if len(mock.reloadConfigCalls) != 1 || mock.reloadConfigCalls[0] != "ext" {
		t.Errorf("reload calls = %v, want one reload of ext", mock.reloadConfigCalls)
	}
	if len(mock.unmarkManagedCalls) != 0 {
		t.Errorf("unmark ran on a successful adopt: %v", mock.unmarkManagedCalls)
	}
	if strings.Join(*swept, ",") != "ext" {
		t.Errorf("swept = %v, want [ext] — adoption is the explicit sweep retry path", *swept)
	}
}

// stubAdoptMigrateLegacy substitutes the adopt handler's legacy-sweep seam and
// records the servers it was asked to sweep.
func stubAdoptMigrateLegacy(t *testing.T, changed bool) *[]string {
	t.Helper()
	swept := &[]string{}
	orig := adoptMigrateLegacy
	adoptMigrateLegacy = func(_ context.Context, server string) (bool, error) {
		*swept = append(*swept, server)
		return changed, nil
	}
	t.Cleanup(func() { adoptMigrateLegacy = orig })
	return swept
}

// TestHandleServerAdopt_LegacySweepGate: the sweep runs only after a
// successful adopt — never for an already-managed target (no mutation path)
// and never after a rolled-back reload.
func TestHandleServerAdopt_LegacySweepGate(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(os.Stderr, nil))

	t.Run("already-managed target is not swept", func(t *testing.T) {
		mock := &serversTmuxMock{}
		mock.isManagedByServer = map[string]bool{"mine": true}
		swept := stubAdoptMigrateLegacy(t, false)

		router := NewTestRouter(logger, nil, mock, "test-host")
		req := httptest.NewRequest("POST", "/api/servers/adopt", strings.NewReader(`{"name":"mine"}`))
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)

		if len(*swept) != 0 {
			t.Errorf("swept = %v, want none — no mutation ran", *swept)
		}
	})

	t.Run("rolled-back reload is not swept", func(t *testing.T) {
		mock := &serversTmuxMock{}
		mock.reloadConfigErr = errors.New("source-file: boom")
		swept := stubAdoptMigrateLegacy(t, false)

		router := NewTestRouter(logger, nil, mock, "test-host")
		req := httptest.NewRequest("POST", "/api/servers/adopt", strings.NewReader(`{"name":"ext"}`))
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)

		if len(*swept) != 0 {
			t.Errorf("swept = %v, want none — the reload failed and rolled back", *swept)
		}
	})
}

// TestHandleServerAdopt_AlreadyManaged: an already-managed target (marked or
// the daemon by derivation) returns 200 already-managed idempotently, with no
// tmux mutation.
func TestHandleServerAdopt_AlreadyManaged(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(os.Stderr, nil))
	mock := &serversTmuxMock{}
	mock.isManagedByServer = map[string]bool{"mine": true}

	router := NewTestRouter(logger, nil, mock, "test-host")
	for _, name := range []string{"mine", "rk-daemon"} {
		req := httptest.NewRequest("POST", "/api/servers/adopt", strings.NewReader(`{"name":"`+name+`"}`))
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)

		if rec.Code != 200 {
			t.Fatalf("%s: status = %d, want 200. body=%s", name, rec.Code, rec.Body.String())
		}
		var body map[string]string
		if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
			t.Fatalf("decode: %v", err)
		}
		if body["status"] != "already-managed" {
			t.Errorf("%s: status = %q, want already-managed. body=%s", name, body["status"], rec.Body.String())
		}
	}
	if len(mock.markManagedCalls) != 0 || len(mock.reloadConfigCalls) != 0 || len(mock.unmarkManagedCalls) != 0 {
		t.Errorf("mutation ran on already-managed targets: marks=%v reloads=%v unmarks=%v",
			mock.markManagedCalls, mock.reloadConfigCalls, mock.unmarkManagedCalls)
	}
}

// TestHandleServerAdopt_ReloadFailureRollsBack: a failed reload best-effort
// unmarks the just-stamped server and returns an error — a stamped server
// whose conf never applied is never left behind.
func TestHandleServerAdopt_ReloadFailureRollsBack(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(os.Stderr, nil))
	mock := &serversTmuxMock{}
	mock.reloadConfigErr = errors.New("source-file: boom")

	router := NewTestRouter(logger, nil, mock, "test-host")
	req := httptest.NewRequest("POST", "/api/servers/adopt", strings.NewReader(`{"name":"ext"}`))
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != 500 {
		t.Fatalf("status = %d, want 500 on reload failure. body=%s", rec.Code, rec.Body.String())
	}
	if len(mock.markManagedCalls) != 1 || mock.markManagedCalls[0] != "ext" {
		t.Errorf("mark calls = %v, want one mark of ext", mock.markManagedCalls)
	}
	if len(mock.unmarkManagedCalls) != 1 || mock.unmarkManagedCalls[0] != "ext" {
		t.Errorf("unmark calls = %v, want one rollback unmark of ext", mock.unmarkManagedCalls)
	}
}

func TestHandleServerAdopt_InvalidNameRejected(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(os.Stderr, nil))
	mock := &serversTmuxMock{}

	router := NewTestRouter(logger, nil, mock, "test-host")
	req := httptest.NewRequest("POST", "/api/servers/adopt", strings.NewReader(`{"name":"bad/name"}`))
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != 400 {
		t.Fatalf("status = %d, want 400 for invalid name", rec.Code)
	}
	if len(mock.markManagedCalls) != 0 || len(mock.reloadConfigCalls) != 0 {
		t.Errorf("mutation ran on an invalid name: marks=%v reloads=%v", mock.markManagedCalls, mock.reloadConfigCalls)
	}
}

func postServerCreate(t *testing.T, mock *serversTmuxMock, body string) *httptest.ResponseRecorder {
	t.Helper()
	logger := slog.New(slog.NewTextHandler(os.Stderr, nil))
	router := NewTestRouter(logger, nil, mock, "test-host")
	req := httptest.NewRequest("POST", "/api/servers", strings.NewReader(body))
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	return rec
}

func TestHandleServerCreate_NoCwdKeepsLegacyBirthSession(t *testing.T) {
	home, _ := os.UserHomeDir()
	mock := &serversTmuxMock{}
	rec := postServerCreate(t, mock, `{"name":"work"}`)

	if rec.Code != 201 {
		t.Fatalf("status = %d, want 201. body=%s", rec.Code, rec.Body.String())
	}
	if mock.createSessionName != "0" || mock.createSessionCwd != home || mock.createSessionServer != "work" {
		t.Errorf("CreateSession(%q, %q, %q), want (\"0\", %q, \"work\")", mock.createSessionName, mock.createSessionCwd, mock.createSessionServer, home)
	}
	var got map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if got["ok"] != true || got["group"] != "0" {
		t.Errorf("body = %v, want ok:true group:\"0\"", got)
	}
}

func TestHandleServerCreate_CwdNamesFirstGroupAfterFolder(t *testing.T) {
	home, _ := os.UserHomeDir()
	tests := []struct {
		name      string
		cwd       string
		wantGroup string
		wantCwd   string
	}{
		{"tilde path", "~/code/hexokit", "hexokit", home + "/code/hexokit"},
		{"dots and hyphens", "~/code/my-app.v2", "my_app_v2", home + "/code/my-app.v2"},
		{"trailing slash", "~/code/hexokit/", "hexokit", home + "/code/hexokit"},
		{"absolute under home", home + "/code/x", "x", home + "/code/x"},
		{"home tilde", "~", "main", home},
		{"home tilde slash", "~/", "main", home},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			mock := &serversTmuxMock{}
			body, _ := json.Marshal(map[string]string{"name": "ws", "cwd": tt.cwd})
			rec := postServerCreate(t, mock, string(body))

			if rec.Code != 201 {
				t.Fatalf("status = %d, want 201. body=%s", rec.Code, rec.Body.String())
			}
			if mock.createSessionName != tt.wantGroup || mock.createSessionCwd != tt.wantCwd || mock.createSessionServer != "ws" {
				t.Errorf("CreateSession(%q, %q, %q), want (%q, %q, \"ws\")", mock.createSessionName, mock.createSessionCwd, mock.createSessionServer, tt.wantGroup, tt.wantCwd)
			}
			var got map[string]any
			if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
				t.Fatalf("decode: %v", err)
			}
			if got["group"] != tt.wantGroup {
				t.Errorf("group = %v, want %q", got["group"], tt.wantGroup)
			}
		})
	}
}

func TestHandleServerCreate_InvalidInputRejectedBeforeTmux(t *testing.T) {
	tests := []struct {
		name    string
		body    string
		wantMsg string
	}{
		{"cwd outside home", `{"name":"x","cwd":"/etc"}`, "Path must be under home directory"},
		{"cwd tilde user", `{"name":"x","cwd":"~root/code"}`, "~user expansion is not supported"},
		{"cwd with newline", `{"name":"x","cwd":"~/a\nb"}`, "Working directory contains invalid characters"},
		{"invalid server name", `{"name":"bad name","cwd":"~/code"}`, "Server name must contain only"},
		{"empty server name", `{"name":""}`, "Server name cannot be empty"},
		{"malformed json", `{`, "Invalid JSON body"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			mock := &serversTmuxMock{}
			rec := postServerCreate(t, mock, tt.body)

			if rec.Code != 400 {
				t.Fatalf("status = %d, want 400. body=%s", rec.Code, rec.Body.String())
			}
			if !strings.Contains(rec.Body.String(), tt.wantMsg) {
				t.Errorf("body = %s, want message containing %q", rec.Body.String(), tt.wantMsg)
			}
			if mock.createSessionCalled {
				t.Error("CreateSession was called for a rejected request")
			}
		})
	}
}

func TestHandleServerCreate_TmuxFailureSurfaces500(t *testing.T) {
	mock := &serversTmuxMock{mockTmuxOps: mockTmuxOps{err: errors.New("tmux boom")}}
	rec := postServerCreate(t, mock, `{"name":"ws","cwd":"~/code/x"}`)

	if rec.Code != 500 {
		t.Fatalf("status = %d, want 500. body=%s", rec.Code, rec.Body.String())
	}
}
