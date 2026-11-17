package api

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"rk/internal/sessions"
	"rk/internal/tmux"
)

func moveBlockFixture() []sessions.ProjectSession {
	return []sessions.ProjectSession{{
		Name: "work",
		Windows: []tmux.WindowInfo{
			sortWin(0, "@1"),
			sortWin(1, "@2"),
			sortWin(2, "@3"),
			sortWin(3, "@4"),
			sortWin(4, "@5"),
		},
	}}
}

func postMoveBlock(t *testing.T, router http.Handler, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/api/windows/move-block", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	return rec
}

func TestMoveBlockSuccess(t *testing.T) {
	tests := []struct {
		name string
		body string
		want []moveWindowCall
	}{
		{
			name: "forward",
			body: `{"windowIds":["@1","@2"],"beforeWindowId":"@5"}`,
			want: []moveWindowCall{{windowID: "@3", dstIndex: 0}, {windowID: "@4", dstIndex: 1}},
		},
		{
			name: "backward",
			body: `{"windowIds":["@2","@4"],"beforeWindowId":"@1"}`,
			want: []moveWindowCall{{windowID: "@2", dstIndex: 0}, {windowID: "@4", dstIndex: 1}},
		},
		{
			name: "scattered",
			body: `{"windowIds":["@4","@2"],"beforeWindowId":"@3"}`,
			want: []moveWindowCall{{windowID: "@4", dstIndex: 1}},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			ops := &mockTmuxOps{}
			router := newTestRouter(&mockSessionFetcher{result: moveBlockFixture()}, ops)
			rec := postMoveBlock(t, router, tt.body)
			if rec.Code != http.StatusOK {
				t.Fatalf("status = %d, want %d; body = %s", rec.Code, http.StatusOK, rec.Body.String())
			}
			if !reflect.DeepEqual(ops.moveWindowCalls, tt.want) {
				t.Fatalf("MoveWindow calls = %v, want %v", ops.moveWindowCalls, tt.want)
			}
			if rec.Body.String() != "{\"ok\":true}\n" {
				t.Fatalf("body = %q, want ok response", rec.Body.String())
			}
		})
	}
}

func TestMoveBlockAlreadyInPlace(t *testing.T) {
	ops := &mockTmuxOps{}
	router := newTestRouter(&mockSessionFetcher{result: moveBlockFixture()}, ops)
	rec := postMoveBlock(t, router, `{"windowIds":["@1"],"beforeWindowId":"@2"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusOK)
	}
	if len(ops.moveWindowCalls) != 0 {
		t.Fatalf("MoveWindow calls = %v, want none", ops.moveWindowCalls)
	}
}

func TestMoveBlockValidation(t *testing.T) {
	bodies := []string{
		`not json`,
		`{}`,
		`{"windowIds":[],"beforeWindowId":"@1"}`,
		`{"windowIds":["bad"],"beforeWindowId":"@1"}`,
		`{"windowIds":["@2","@2"],"beforeWindowId":"@1"}`,
		`{"windowIds":["@2"],"beforeWindowId":"bad"}`,
		`{"windowIds":["@2"],"beforeWindowId":"@2"}`,
		`{"windowIds":["@2"]}`,
	}
	for _, body := range bodies {
		t.Run(body, func(t *testing.T) {
			ops := &mockTmuxOps{}
			fetcher := &mockSessionFetcher{result: moveBlockFixture()}
			router := newTestRouter(fetcher, ops)
			rec := postMoveBlock(t, router, body)
			if rec.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, want %d", rec.Code, http.StatusBadRequest)
			}
			if fetcher.calls != 0 {
				t.Fatalf("FetchSessions calls = %d, want 0", fetcher.calls)
			}
			if len(ops.moveWindowCalls) != 0 || ops.moveWindowToSessionCalled {
				t.Fatal("tmux mutation called for invalid body")
			}
		})
	}
}

func TestMoveBlockUnknownWindows(t *testing.T) {
	tests := []struct {
		name string
		body string
		want int
	}{
		{name: "unknown target", body: `{"windowIds":["@2"],"beforeWindowId":"@99"}`, want: http.StatusNotFound},
		{name: "unknown member", body: `{"windowIds":["@99"],"beforeWindowId":"@1"}`, want: http.StatusBadRequest},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			ops := &mockTmuxOps{}
			router := newTestRouter(&mockSessionFetcher{result: moveBlockFixture()}, ops)
			rec := postMoveBlock(t, router, tt.body)
			if rec.Code != tt.want {
				t.Fatalf("status = %d, want %d", rec.Code, tt.want)
			}
			if len(ops.moveWindowCalls) != 0 || ops.moveWindowToSessionCalled {
				t.Fatal("tmux mutation called for unknown window")
			}
		})
	}
}

func TestMoveBlockMoveError(t *testing.T) {
	ops := &mockTmuxOps{swapWindowErr: errors.New("move failed")}
	router := newTestRouter(&mockSessionFetcher{result: moveBlockFixture()}, ops)
	rec := postMoveBlock(t, router, `{"windowIds":["@2"],"beforeWindowId":"@1"}`)
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusInternalServerError)
	}
	if !strings.Contains(rec.Body.String(), "move failed") {
		t.Fatalf("body = %q, want tmux error", rec.Body.String())
	}
}

type moveBlockFetcher struct {
	before []sessions.ProjectSession
	after  []sessions.ProjectSession
	calls  int
}

func (f *moveBlockFetcher) FetchSessions(context.Context, string) ([]sessions.ProjectSession, error) {
	f.calls++
	if f.calls > 1 && f.after != nil {
		return f.after, nil
	}
	return f.before, nil
}

type recordingMoveBlockOps struct {
	*mockTmuxOps
	operations []string
}

func (o *recordingMoveBlockOps) MoveWindow(windowID string, targetIndex int, server string) error {
	o.operations = append(o.operations, fmt.Sprintf("move:%s:%d", windowID, targetIndex))
	return o.mockTmuxOps.MoveWindow(windowID, targetIndex, server)
}

func (o *recordingMoveBlockOps) MoveWindowToSession(windowID, dstSession, server string) error {
	o.operations = append(o.operations, fmt.Sprintf("session:%s:%s", windowID, dstSession))
	return o.mockTmuxOps.MoveWindowToSession(windowID, dstSession, server)
}

func TestMoveBlockCrossSessionPreMoves(t *testing.T) {
	fetcher := &moveBlockFetcher{
		before: []sessions.ProjectSession{
			{Name: "work", Windows: []tmux.WindowInfo{sortWin(0, "@1"), sortWin(1, "@3"), sortWin(2, "@5")}},
			{Name: "other", Windows: []tmux.WindowInfo{sortWin(0, "@2"), sortWin(1, "@4")}},
		},
		after: []sessions.ProjectSession{
			{Name: "work", Windows: []tmux.WindowInfo{sortWin(0, "@1"), sortWin(1, "@3"), sortWin(2, "@5"), sortWin(3, "@2"), sortWin(4, "@4")}},
		},
	}
	ops := &recordingMoveBlockOps{mockTmuxOps: &mockTmuxOps{}}
	router := newTestRouter(fetcher, ops)
	rec := postMoveBlock(t, router, `{"windowIds":["@2","@4"],"beforeWindowId":"@1"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body = %s", rec.Code, http.StatusOK, rec.Body.String())
	}
	want := []string{"session:@2:work", "session:@4:work", "move:@2:0", "move:@4:1"}
	if !reflect.DeepEqual(ops.operations, want) {
		t.Fatalf("operations = %v, want %v", ops.operations, want)
	}
	if fetcher.calls != 2 {
		t.Fatalf("FetchSessions calls = %d, want 2", fetcher.calls)
	}
}

func TestMoveBlockCrossSessionError(t *testing.T) {
	fetcher := &mockSessionFetcher{result: []sessions.ProjectSession{
		{Name: "work", Windows: []tmux.WindowInfo{sortWin(0, "@1")}},
		{Name: "other", Windows: []tmux.WindowInfo{sortWin(0, "@2")}},
	}}
	ops := &mockTmuxOps{moveWindowToSessionErr: errors.New("session move failed")}
	router := newTestRouter(fetcher, ops)
	rec := postMoveBlock(t, router, `{"windowIds":["@2"],"beforeWindowId":"@1"}`)
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusInternalServerError)
	}
	if len(ops.moveWindowCalls) != 0 {
		t.Fatalf("MoveWindow calls = %v, want none after pre-move failure", ops.moveWindowCalls)
	}
}
