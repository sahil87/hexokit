package api

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
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
	server.operatorStatePathFn = func(context.Context, string) (string, error) {
		return operator.StatePath(notesTestSock)
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

func postNote(t *testing.T, router http.Handler, body string) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/operator/notes", bytes.NewBufferString(body)))
	return rec
}

func noteBody(server, id, text string) string {
	b, _ := json.Marshal(operatorNoteBody{Server: server, ID: id, Text: text})
	return string(b)
}

func TestOperatorNoteAdd(t *testing.T) {
	t.Run("200 appends a trimmed by-user note and the GET reads it back last", func(t *testing.T) {
		router := notesServer(t)
		rk, _ := operator.StatePath(notesTestSock)
		writeNotesFile(t, rk, rkNotesBody)

		rec := postNote(t, router, noteBody("runKit", "x", "  merge once green "))
		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
		}
		var receipt operatorNoteReceipt
		if err := json.NewDecoder(rec.Body).Decode(&receipt); err != nil {
			t.Fatal(err)
		}
		if receipt.ID != "x" || receipt.Note.By != "user" || receipt.Note.Text != "merge once green" || receipt.Note.At == 0 {
			t.Errorf("receipt = %+v", receipt)
		}

		got := getNotes(t, router, "?server=runKit&id=x")
		var notes operatorNotesJSON
		if err := json.NewDecoder(got.Body).Decode(&notes); err != nil || len(notes.Notes) != 3 {
			t.Fatalf("notes = %+v err=%v, want 3 notes", notes, err)
		}
		if last := notes.Notes[2]; last.By != "user" || last.Text != "merge once green" {
			t.Errorf("last note = %+v", last)
		}
	})

	t.Run("404 for an unknown item and the file is unchanged", func(t *testing.T) {
		router := notesServer(t)
		rk, _ := operator.StatePath(notesTestSock)
		writeNotesFile(t, rk, rkNotesBody)
		rec := postNote(t, router, noteBody("runKit", "nope", "hi"))
		if rec.Code != http.StatusNotFound {
			t.Fatalf("status = %d, want 404", rec.Code)
		}
		if raw, _ := os.ReadFile(rk); string(raw) != rkNotesBody {
			t.Errorf("rk file changed on a 404:\n%s", raw)
		}
	})

	t.Run("404 when only fab's legacy file exists; fab's file is byte-identical and no rk file appears", func(t *testing.T) {
		router := notesServer(t)
		rk, _ := operator.StatePath(notesTestSock)
		fab, _ := cron.FabOperatorStatePath(cron.FabOperatorSlug(notesTestSock))
		const fabBody = "tracked:\n  - {id: x, kind: note, text: from fab}\n"
		writeNotesFile(t, fab, fabBody)

		rec := postNote(t, router, noteBody("runKit", "x", "hi"))
		if rec.Code != http.StatusNotFound {
			t.Fatalf("status = %d, want 404", rec.Code)
		}
		if raw, _ := os.ReadFile(fab); string(raw) != fabBody {
			t.Errorf("fab's file changed:\n%s", raw)
		}
		if _, err := os.Stat(rk); !os.IsNotExist(err) {
			t.Errorf("rk file created by a refused note (stat err %v)", err)
		}
	})

	t.Run("400 for empty text, over-cap text, missing id, bad server and bad JSON", func(t *testing.T) {
		router := notesServer(t)
		rk, _ := operator.StatePath(notesTestSock)
		writeNotesFile(t, rk, rkNotesBody)
		over := strings.Repeat("a", operator.NoteTextCap+1)
		cases := map[string]string{
			"empty":      noteBody("runKit", "x", "   "),
			"over cap":   noteBody("runKit", "x", over),
			"missing id": noteBody("runKit", "", "hi"),
			"bad server": noteBody("bad/server", "x", "hi"),
			"bad json":   "{not json",
		}
		for name, body := range cases {
			rec := postNote(t, router, body)
			if rec.Code != http.StatusBadRequest {
				t.Errorf("%s: status = %d, want 400; body=%s", name, rec.Code, rec.Body.String())
			}
		}
		rec := postNote(t, router, cases["over cap"])
		if !strings.Contains(rec.Body.String(), "over the") {
			t.Errorf("over-cap message = %s, want the validator's text", rec.Body.String())
		}
		if raw, _ := os.ReadFile(rk); string(raw) != rkNotesBody {
			t.Errorf("rk file changed on a 400:\n%s", raw)
		}
	})

	t.Run("the write does not drop a wake marker", func(t *testing.T) {
		t.Setenv("XDG_STATE_HOME", t.TempDir())
		server, _ := newWakeSeamServer(t, &mockTmuxOps{})
		cronDir := t.TempDir()
		server.cronDirFn = func() (string, error) { return cronDir, nil }
		server.operatorStatePathFn = func(context.Context, string) (string, error) {
			return operator.StatePath(notesTestSock)
		}
		rk, _ := operator.StatePath(notesTestSock)
		writeNotesFile(t, rk, rkNotesBody)

		if rec := postNote(t, server.buildRouter(), noteBody("runKit", "x", "hi")); rec.Code != http.StatusOK {
			t.Fatalf("status = %d", rec.Code)
		}
		if entries, _ := os.ReadDir(cronDir); len(entries) != 0 {
			t.Errorf("cron dir not empty after a note write: %v", entries)
		}
	})
}
