package api

// Tests for the web-tab verb routes (POST /api/windows/{windowId}/web[...]) —
// the handlers' tmux verbs ride package seams (windows_web.go), so the tests
// pin status codes, response shapes, and the pre-tmux gates without a live
// server.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"rk/internal/tmux"
)

// stubWebAdd pins the WebAdd seam; the returned pointer records the (url, root)
// pairs it was called with.
func stubWebAdd(t *testing.T, index int, existed bool, err error) *[]webAddCall {
	t.Helper()
	calls := []webAddCall{}
	prev := webAddFn
	webAddFn = func(_ context.Context, _, _, url, root string) (int, bool, error) {
		calls = append(calls, webAddCall{url: url, root: root})
		return index, existed, err
	}
	t.Cleanup(func() { webAddFn = prev })
	return &calls
}

type webAddCall struct {
	url  string
	root string
}

func postWebVerb(t *testing.T, router http.Handler, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	var reader *strings.Reader
	if body != "" {
		reader = strings.NewReader(body)
	} else {
		reader = strings.NewReader("")
	}
	req := httptest.NewRequest(http.MethodPost, path, reader)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	return rec
}

// A fresh add lands in slot len+1: 201 with the index, existed=false, and the
// stored URL; the family is read (for the URL's slot segment) and the add verb
// carries the URL with an empty root for port targets.
func TestWindowWebAddCreated(t *testing.T) {
	stubWebTabFamily(t, tmux.WebTabFamily{})
	calls := stubWebAdd(t, 1, false, nil)
	ops := &mockTmuxOps{resolveWindowSessionResult: "dev"}
	router := newTestRouter(&mockSessionFetcher{}, ops)

	rec := postWebVerb(t, router, "/api/windows/@5/web", `{"target":":3000"}`)
	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, want %d; body=%s", rec.Code, http.StatusCreated, rec.Body.String())
	}
	var body map[string]any
	if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if body["index"] != float64(1) || body["existed"] != false {
		t.Errorf("body = %v, want index=1 existed=false", body)
	}
	if body["url"] != "/proxy/3000/" {
		t.Errorf("url = %v, want /proxy/3000/", body["url"])
	}
	if len(*calls) != 1 {
		t.Fatalf("WebAdd calls = %v, want exactly 1", *calls)
	}
	if (*calls)[0].url != "/proxy/3000/" || (*calls)[0].root != "" {
		t.Errorf("WebAdd(url=%q, root=%q), want url=/proxy/3000/ root=\"\"", (*calls)[0].url, (*calls)[0].root)
	}
}

func TestWindowWebAddUsesRequestOrigin(t *testing.T) {
	stubWebTabFamily(t, tmux.WebTabFamily{})
	calls := stubWebAdd(t, 1, false, nil)
	ops := &mockTmuxOps{resolveWindowSessionResult: "dev"}
	router := newTestRouter(&mockSessionFetcher{}, ops)
	req := httptest.NewRequest(
		http.MethodPost,
		"http://dashboard.test/api/windows/@5/web",
		strings.NewReader(`{"target":"https://dashboard.test/tutorial/ch1-orientation.html?chapter=1"}`),
	)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Forwarded-Proto", "https")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, want %d; body=%s", rec.Code, http.StatusCreated, rec.Body.String())
	}
	const wantURL = "/tutorial/ch1-orientation.html?chapter=1"
	if len(*calls) != 1 || (*calls)[0].url != wantURL {
		t.Errorf("WebAdd calls = %+v, want one call with %q", *calls, wantURL)
	}
}

// A full family surfaces ErrWebTabsFull as 409 with the cap in the message.
func TestWindowWebAddFull(t *testing.T) {
	fam := tmux.WebTabFamily{Active: 1}
	for i := 1; i <= tmux.MaxWebTabs; i++ {
		fam.Tabs = append(fam.Tabs, "/proxy/1/")
	}
	stubWebTabFamily(t, fam)
	stubWebAdd(t, 0, false, tmux.ErrWebTabsFull)
	ops := &mockTmuxOps{resolveWindowSessionResult: "dev"}
	router := newTestRouter(&mockSessionFetcher{}, ops)

	rec := postWebVerb(t, router, "/api/windows/@5/web", `{"target":":3000"}`)
	if rec.Code != http.StatusConflict {
		t.Fatalf("status = %d, want %d; body=%s", rec.Code, http.StatusConflict, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), fmt.Sprintf("web tabs full (%d)", tmux.MaxWebTabs)) {
		t.Errorf("body = %s, want the cap message", rec.Body.String())
	}
}

// An empty or unparseable target is a 400 before any tmux work.
func TestWindowWebAddBadTarget(t *testing.T) {
	for _, body := range []string{`{"target":""}`, `{"target":"   "}`, `not json`} {
		ops := &mockTmuxOps{}
		router := newTestRouter(&mockSessionFetcher{}, ops)
		rec := postWebVerb(t, router, "/api/windows/@5/web", body)
		if rec.Code != http.StatusBadRequest {
			t.Errorf("body %s: status = %d, want %d", body, rec.Code, http.StatusBadRequest)
		}
	}
}

// The slot gate (1..tmux.MaxWebTabs) fires before any tmux call; an
// out-of-family slot maps ErrWebTabRange to 400; a good select/remove is 200
// {"ok":true}.
func TestWindowWebRemoveSelect(t *testing.T) {
	t.Run("slot above the cap gated", func(t *testing.T) {
		called := false
		prevR, prevS := webRemoveFn, webSelectFn
		webRemoveFn = func(context.Context, string, string, int) error { called = true; return nil }
		webSelectFn = func(context.Context, string, string, int) error { called = true; return nil }
		t.Cleanup(func() { webRemoveFn, webSelectFn = prevR, prevS })
		router := newTestRouter(&mockSessionFetcher{}, &mockTmuxOps{})
		over := tmux.MaxWebTabs + 1
		for _, path := range []string{
			fmt.Sprintf("/api/windows/@5/web/%d/remove", over),
			fmt.Sprintf("/api/windows/@5/web/%d/select", over),
		} {
			rec := postWebVerb(t, router, path, "")
			if rec.Code != http.StatusBadRequest {
				t.Errorf("%s: status = %d, want %d", path, rec.Code, http.StatusBadRequest)
			}
		}
		if called {
			t.Error("tmux verb seam called for a gated slot — gate must fire first")
		}
	})
	t.Run("top slot passes the gate", func(t *testing.T) {
		var gotN int
		prevR := webRemoveFn
		webRemoveFn = func(_ context.Context, _, _ string, n int) error { gotN = n; return nil }
		t.Cleanup(func() { webRemoveFn = prevR })
		router := newTestRouter(&mockSessionFetcher{}, &mockTmuxOps{})
		rec := postWebVerb(t, router, fmt.Sprintf("/api/windows/@5/web/%d/remove", tmux.MaxWebTabs), "")
		if rec.Code != http.StatusOK {
			t.Errorf("status = %d, want %d; body=%s", rec.Code, http.StatusOK, rec.Body.String())
		}
		if gotN != tmux.MaxWebTabs {
			t.Errorf("remove seam n = %d, want %d", gotN, tmux.MaxWebTabs)
		}
	})
	t.Run("range error is 400", func(t *testing.T) {
		prevR, prevS := webRemoveFn, webSelectFn
		webRemoveFn = func(context.Context, string, string, int) error { return tmux.ErrWebTabRange }
		webSelectFn = func(context.Context, string, string, int) error { return tmux.ErrWebTabRange }
		t.Cleanup(func() { webRemoveFn, webSelectFn = prevR, prevS })
		router := newTestRouter(&mockSessionFetcher{}, &mockTmuxOps{})
		for _, path := range []string{"/api/windows/@5/web/2/remove", "/api/windows/@5/web/2/select"} {
			rec := postWebVerb(t, router, path, "")
			if rec.Code != http.StatusBadRequest {
				t.Errorf("%s: status = %d, want %d", path, rec.Code, http.StatusBadRequest)
			}
		}
	})
	t.Run("success is 200 ok", func(t *testing.T) {
		prevR, prevS := webRemoveFn, webSelectFn
		webRemoveFn = func(context.Context, string, string, int) error { return nil }
		webSelectFn = func(context.Context, string, string, int) error { return nil }
		t.Cleanup(func() { webRemoveFn, webSelectFn = prevR, prevS })
		router := newTestRouter(&mockSessionFetcher{}, &mockTmuxOps{})
		for _, path := range []string{"/api/windows/@5/web/2/remove", "/api/windows/@5/web/2/select"} {
			rec := postWebVerb(t, router, path, "")
			if rec.Code != http.StatusOK {
				t.Errorf("%s: status = %d, want %d; body=%s", path, rec.Code, http.StatusOK, rec.Body.String())
			}
			var body map[string]bool
			if err := json.NewDecoder(rec.Body).Decode(&body); err != nil || !body["ok"] {
				t.Errorf("%s: body = %s, want {\"ok\":true}", path, rec.Body.String())
			}
		}
	})
}

// A successful verb wakes the SSE hub (set-option is invisible to the
// control-mode parser — the /options precedent). Shares newWakeSeamServer /
// expectWake with the /options seam test.
func TestWindowWebSelectWakesHub(t *testing.T) {
	prev := webSelectFn
	webSelectFn = func(context.Context, string, string, int) error { return nil }
	t.Cleanup(func() { webSelectFn = prev })

	server, tracker := newWakeSeamServer(t, &mockTmuxOps{})
	before := tracker.count.Load()
	router := server.buildRouter()
	rec := postWebVerb(t, router, "/api/windows/@5/web/2/select?server=default", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	expectWake(t, tracker, before, "web select")
}

// A verb against an unknown window surfaces the family-read failure as 500,
// not a silent success.
func TestWindowWebAddFamilyReadError(t *testing.T) {
	prev := webTabFamilyFn
	webTabFamilyFn = func(context.Context, string, string) (tmux.WebTabFamily, error) {
		return tmux.WebTabFamily{}, errors.New("no such window")
	}
	t.Cleanup(func() { webTabFamilyFn = prev })
	ops := &mockTmuxOps{resolveWindowSessionResult: "dev"}
	router := newTestRouter(&mockSessionFetcher{}, ops)

	rec := postWebVerb(t, router, "/api/windows/@5/web", `{"target":":3000"}`)
	if rec.Code != http.StatusInternalServerError {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusInternalServerError)
	}
}

// The move verb mirrors remove/select on every gate: {to} decodes from the
// body, ErrWebTabRange maps to 400, and a successful move resolves as
// {"ok":true}.
func TestWindowWebMove(t *testing.T) {
	t.Run("slot above the cap gated before any tmux call", func(t *testing.T) {
		called := false
		prev := webMoveFn
		webMoveFn = func(context.Context, string, string, int, int) error { called = true; return nil }
		t.Cleanup(func() { webMoveFn = prev })
		router := newTestRouter(&mockSessionFetcher{}, &mockTmuxOps{})
		rec := postWebVerb(t, router, fmt.Sprintf("/api/windows/@5/web/%d/move", tmux.MaxWebTabs+1), `{"to":1}`)
		if rec.Code != http.StatusBadRequest {
			t.Errorf("status = %d, want %d", rec.Code, http.StatusBadRequest)
		}
		if called {
			t.Error("move seam called for a gated slot — gate must fire first")
		}
	})
	t.Run("range error is 400", func(t *testing.T) {
		prev := webMoveFn
		webMoveFn = func(context.Context, string, string, int, int) error { return tmux.ErrWebTabRange }
		t.Cleanup(func() { webMoveFn = prev })
		router := newTestRouter(&mockSessionFetcher{}, &mockTmuxOps{})
		rec := postWebVerb(t, router, "/api/windows/@5/web/5/move", `{"to":1}`)
		if rec.Code != http.StatusBadRequest {
			t.Errorf("status = %d, want %d; body=%s", rec.Code, http.StatusBadRequest, rec.Body.String())
		}
	})
	t.Run("bad body is 400 before any tmux call", func(t *testing.T) {
		called := false
		prev := webMoveFn
		webMoveFn = func(context.Context, string, string, int, int) error { called = true; return nil }
		t.Cleanup(func() { webMoveFn = prev })
		router := newTestRouter(&mockSessionFetcher{}, &mockTmuxOps{})
		rec := postWebVerb(t, router, "/api/windows/@5/web/2/move", `not json`)
		if rec.Code != http.StatusBadRequest {
			t.Errorf("status = %d, want %d", rec.Code, http.StatusBadRequest)
		}
		if called {
			t.Error("move seam called for an undecodable body — decode must gate first")
		}
	})
	t.Run("destination outside the cap is gated before any tmux call", func(t *testing.T) {
		called := false
		prev := webMoveFn
		webMoveFn = func(context.Context, string, string, int, int) error { called = true; return nil }
		t.Cleanup(func() { webMoveFn = prev })
		router := newTestRouter(&mockSessionFetcher{}, &mockTmuxOps{})
		for _, body := range []string{`{"to":0}`, fmt.Sprintf(`{"to":%d}`, tmux.MaxWebTabs+1)} {
			rec := postWebVerb(t, router, "/api/windows/@5/web/2/move", body)
			if rec.Code != http.StatusBadRequest {
				t.Errorf("body=%s: status = %d, want %d", body, rec.Code, http.StatusBadRequest)
			}
		}
		if called {
			t.Error("move seam called for a destination outside 1..MaxWebTabs")
		}
	})
	t.Run("success carries n and to", func(t *testing.T) {
		type call struct{ n, to int }
		calls := []call{}
		prev := webMoveFn
		webMoveFn = func(_ context.Context, _, _ string, n, to int) error {
			calls = append(calls, call{n, to})
			return nil
		}
		t.Cleanup(func() { webMoveFn = prev })
		router := newTestRouter(&mockSessionFetcher{}, &mockTmuxOps{})
		rec := postWebVerb(t, router, "/api/windows/@5/web/2/move", `{"to":3}`)
		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
		}
		if len(calls) != 1 || calls[0].n != 2 || calls[0].to != 3 {
			t.Errorf("move calls = %v, want exactly (n=2, to=3)", calls)
		}
		var body map[string]bool
		if err := json.NewDecoder(rec.Body).Decode(&body); err != nil || !body["ok"] {
			t.Errorf("body = %s, want {\"ok\":true}", rec.Body.String())
		}
	})
}

// A successful move wakes the SSE hub like its sibling verbs.
func TestWindowWebMoveWakesHub(t *testing.T) {
	prev := webMoveFn
	webMoveFn = func(context.Context, string, string, int, int) error { return nil }
	t.Cleanup(func() { webMoveFn = prev })

	server, tracker := newWakeSeamServer(t, &mockTmuxOps{})
	before := tracker.count.Load()
	router := server.buildRouter()
	rec := postWebVerb(t, router, "/api/windows/@5/web/1/move?server=default", `{"to":2}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	expectWake(t, tracker, before, "web move")
}
