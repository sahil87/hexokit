package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"rk/internal/cron"
	"rk/internal/operator"
	"rk/internal/sessions"
)

// operator_notes_test.go — GET /api/operator/notes round-trips. The state home
// is a per-test XDG_STATE_HOME temp dir; operatorStateFn pins the socket path
// so the real rk-first / fab-fallback selection runs without a tmux query.

const notesTestSock = "/tmp/tmux-1001/runKit"

func notesServer(t *testing.T) http.Handler {
	t.Helper()
	t.Setenv("XDG_STATE_HOME", t.TempDir())
	server, _ := newWakeSeamServer(t, &mockTmuxOps{})
	server.operatorStateFn = func(context.Context, string) (cron.OperatorState, bool) {
		return sessions.ReadOperatorState(notesTestSock)
	}
	return server.buildRouter()
}

func writeNotesFile(t *testing.T, path, body string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

func getNotes(t *testing.T, router http.Handler, query string) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/operator/notes"+query, nil))
	return rec
}

const rkNotesBody = `tracked:
  - id: x
    kind: pane
    notes:
      - {at: 1700000100, by: user, text: "first"}
      - {at: 1700000200, by: run, text: "second\nline two"}
  - id: bare
    kind: task
`

func TestOperatorNotes(t *testing.T) {
	t.Run("200 with every note in file order", func(t *testing.T) {
		router := notesServer(t)
		rk, _ := operator.StatePath(notesTestSock)
		writeNotesFile(t, rk, rkNotesBody)

		rec := getNotes(t, router, "?server=runKit&id=x")
		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
		}
		var body operatorNotesJSON
		if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		want := []sessions.OperatorNote{
			{At: 1700000100, By: "user", Text: "first"},
			{At: 1700000200, By: "run", Text: "second\nline two"},
		}
		if body.ID != "x" || len(body.Notes) != 2 || body.Notes[0] != want[0] || body.Notes[1] != want[1] {
			t.Errorf("body = %+v, want id x with %+v", body, want)
		}
	})

	t.Run("an item without notes is 200 with an empty list", func(t *testing.T) {
		router := notesServer(t)
		rk, _ := operator.StatePath(notesTestSock)
		writeNotesFile(t, rk, rkNotesBody)

		rec := getNotes(t, router, "?id=bare")
		if rec.Code != http.StatusOK || !json.Valid(rec.Body.Bytes()) {
			t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
		}
		var raw map[string]json.RawMessage
		_ = json.Unmarshal(rec.Body.Bytes(), &raw)
		if string(raw["notes"]) != "[]" {
			t.Errorf("notes = %s, want []", raw["notes"])
		}
	})

	t.Run("400 when id is missing or empty", func(t *testing.T) {
		router := notesServer(t)
		for _, q := range []string{"", "?server=runKit", "?id="} {
			if rec := getNotes(t, router, q); rec.Code != http.StatusBadRequest {
				t.Errorf("query %q: status = %d, want 400", q, rec.Code)
			}
		}
	})

	t.Run("404 for an unknown id", func(t *testing.T) {
		router := notesServer(t)
		rk, _ := operator.StatePath(notesTestSock)
		writeNotesFile(t, rk, rkNotesBody)
		if rec := getNotes(t, router, "?id=nope"); rec.Code != http.StatusNotFound {
			t.Errorf("status = %d, want 404", rec.Code)
		}
	})

	t.Run("404 when no state file exists", func(t *testing.T) {
		router := notesServer(t)
		if rec := getNotes(t, router, "?id=x"); rec.Code != http.StatusNotFound {
			t.Errorf("status = %d, want 404", rec.Code)
		}
	})

	t.Run("404 for a corrupt rk file even when fab's file has the id", func(t *testing.T) {
		router := notesServer(t)
		rk, _ := operator.StatePath(notesTestSock)
		fab, _ := cron.FabOperatorStatePath(cron.FabOperatorSlug(notesTestSock))
		writeNotesFile(t, rk, "tracked: [unterminated\n  - {")
		writeNotesFile(t, fab, "tracked:\n  - {id: x, kind: note, text: from fab}\n")
		if rec := getNotes(t, router, "?id=x"); rec.Code != http.StatusNotFound {
			t.Errorf("status = %d, want 404 (no fall back from a corrupt rk file)", rec.Code)
		}
	})

	t.Run("rk file wins over fab's; fab is the fallback with its text as a user note", func(t *testing.T) {
		router := notesServer(t)
		rk, _ := operator.StatePath(notesTestSock)
		fab, _ := cron.FabOperatorStatePath(cron.FabOperatorSlug(notesTestSock))
		writeNotesFile(t, fab, "tracked:\n  - {id: x, kind: note, text: \"from fab\", updated_at: 1700000500}\n")

		rec := getNotes(t, router, "?id=x")
		var body operatorNotesJSON
		if err := json.NewDecoder(rec.Body).Decode(&body); err != nil || rec.Code != http.StatusOK {
			t.Fatalf("fallback: status = %d err=%v body=%s", rec.Code, err, rec.Body.String())
		}
		if len(body.Notes) != 1 || body.Notes[0] != (sessions.OperatorNote{At: 1700000500, By: "user", Text: "from fab"}) {
			t.Errorf("fallback notes = %+v, want fab's text as one user note", body.Notes)
		}

		writeNotesFile(t, rk, rkNotesBody)
		rec = getNotes(t, router, "?id=x")
		body = operatorNotesJSON{}
		if err := json.NewDecoder(rec.Body).Decode(&body); err != nil || len(body.Notes) != 2 {
			t.Errorf("rk present: body = %+v err=%v, want rk's two notes", body, err)
		}
	})

	t.Run("the route never writes either state file", func(t *testing.T) {
		router := notesServer(t)
		rk, _ := operator.StatePath(notesTestSock)
		fab, _ := cron.FabOperatorStatePath(cron.FabOperatorSlug(notesTestSock))
		getNotes(t, router, "?id=x")
		for _, p := range []string{rk, fab} {
			if _, err := os.Stat(p); !os.IsNotExist(err) {
				t.Errorf("%s exists after a read (stat err %v)", p, err)
			}
		}
	})
}
