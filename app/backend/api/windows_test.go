package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"rk/internal/sessions"
	"rk/internal/snapshot"
	"rk/internal/tmux"
	"rk/internal/validate"
)

// --- Window Options endpoint tests (POST /api/windows/{id}/options) ---
//
// findOp returns the recorded WindowOptionOp for key, or (zero, false). The
// /options handler iterates a map, so op order is non-deterministic — tests
// assert by key, not by slice position.
func findOp(ops []tmux.WindowOptionOp, key string) (tmux.WindowOptionOp, bool) {
	for _, op := range ops {
		if op.Key == key {
			return op, true
		}
	}
	return tmux.WindowOptionOp{}, false
}

// stubWebTabFamily pins the family-read seam to a fixed family for the test's
// duration: the /options handler reads the current family once per batch when
// a family-relative key is present, and must never consult a real tmux server.
// Tests posting a family-relative key (@rk_win_web_*, _active, or the retired
// @rk_win_url/@rk_win_lens compat keys) MUST call this first.
func stubWebTabFamily(t *testing.T, fam tmux.WebTabFamily) {
	t.Helper()
	prev := webTabFamilyFn
	webTabFamilyFn = func(context.Context, string, string) (tmux.WebTabFamily, error) { return fam, nil }
	t.Cleanup(func() { webTabFamilyFn = prev })
}

// stubWebRemove captures the slots WebRemove was asked to remove (a null on a
// web slot routes through it) instead of hitting tmux. Returned slice is in
// call order.
func stubWebRemove(t *testing.T) *[]int {
	t.Helper()
	removed := []int{}
	prev := webRemoveFn
	webRemoveFn = func(_ context.Context, _, _ string, n int) error {
		removed = append(removed, n)
		return nil
	}
	t.Cleanup(func() { webRemoveFn = prev })
	return &removed
}

func postOptions(t *testing.T, ops *mockTmuxOps, windowID, body string) *httptest.ResponseRecorder {
	t.Helper()
	router := newTestRouter(&mockSessionFetcher{}, ops)
	req := httptest.NewRequest(http.MethodPost, "/api/windows/"+windowID+"/options", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	return rec
}

// Set color only — the merge issues one SetWindowOptions call with just @rk_win_color;
// @rk_win_url/@rk_win_lens are left untouched (absent from the op list).
func TestWindowOptionsSetColorOnly(t *testing.T) {
	ops := &mockTmuxOps{}
	rec := postOptions(t, ops, "@2", `{"options":{"@rk_win_color":"5"}}`)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body=%s", rec.Code, http.StatusOK, rec.Body.String())
	}
	if !ops.setWindowOptionsCalled {
		t.Fatal("SetWindowOptions was not called")
	}
	if ops.setWindowOptionsWindowID != "@2" {
		t.Errorf("windowID = %q, want %q", ops.setWindowOptionsWindowID, "@2")
	}
	if len(ops.setWindowOptionsOps) != 1 {
		t.Fatalf("ops = %v, want exactly 1 (@rk_win_color)", ops.setWindowOptionsOps)
	}
	op, ok := findOp(ops.setWindowOptionsOps, "@rk_win_color")
	if !ok || op.Value == nil || *op.Value != "5" {
		t.Errorf("@rk_win_color op = %+v, want value \"5\"", op)
	}
}

// Explicit null unsets — a nil Value op is recorded for @rk_win_color.
func TestWindowOptionsNullUnsets(t *testing.T) {
	ops := &mockTmuxOps{}
	rec := postOptions(t, ops, "@2", `{"options":{"@rk_win_color":null}}`)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusOK)
	}
	op, ok := findOp(ops.setWindowOptionsOps, "@rk_win_color")
	if !ok {
		t.Fatal("expected @rk_win_color op")
	}
	if op.Value != nil {
		t.Errorf("@rk_win_color value = %q, want nil (unset)", *op.Value)
	}
}

// Multi-key merge is a single SetWindowOptions invocation carrying both keys.
// The retired @rk_win_url/@rk_win_lens keys ride the compat translation onto
// the web-tab family (@rk_win_web_1 + @rk_win_layout), with the compat
// _active=1 armed because the family is empty.
// retire-with: legacy-option-key-translation
func TestWindowOptionsMultiKeyOneCall(t *testing.T) {
	stubWebTabFamily(t, tmux.WebTabFamily{})
	ops := &mockTmuxOps{}
	rec := postOptions(t, ops, "@2", `{"options":{"@rk_win_url":"https://x","@rk_win_lens":"iframe"}}`)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusOK)
	}
	if len(ops.setWindowOptionsOps) != 3 {
		t.Fatalf("ops = %v, want 3 (one invocation: web_1 + layout + armed _active)", ops.setWindowOptionsOps)
	}
	urlOp, ok := findOp(ops.setWindowOptionsOps, "@rk_win_web_1")
	if !ok || urlOp.Value == nil || *urlOp.Value != "https://x" {
		t.Errorf("@rk_win_web_1 op = %+v, want value \"https://x\"", urlOp)
	}
	layoutOp, ok := findOp(ops.setWindowOptionsOps, "@rk_win_layout")
	if !ok || layoutOp.Value == nil || *layoutOp.Value != "web" {
		t.Errorf("@rk_win_layout op = %+v, want value \"web\"", layoutOp)
	}
	activeOp, ok := findOp(ops.setWindowOptionsOps, "@rk_win_web_active")
	if !ok || activeOp.Value == nil || *activeOp.Value != "1" {
		t.Errorf("@rk_win_web_active op = %+v, want value \"1\" (armed on empty family)", activeOp)
	}
}

// Invalid @rk_win_color values are rejected before any tmux call. Family
// names themselves ("red", "red-dark") are valid.
func TestWindowOptionsColorInvalid(t *testing.T) {
	for _, value := range []string{"99", "bluish"} {
		ops := &mockTmuxOps{}
		rec := postOptions(t, ops, "@0", `{"options":{"@rk_win_color":"`+value+`"}}`)

		if rec.Code != http.StatusBadRequest {
			t.Errorf("value %q: status = %d, want %d", value, rec.Code, http.StatusBadRequest)
		}
		if ops.setWindowOptionsCalled {
			t.Errorf("value %q: SetWindowOptions must NOT be called", value)
		}
	}
}

// Family-name @rk_win_color values (both shades) are accepted alongside the numeric
// vocabulary — dark shades have no legacy numeric form and are stored verbatim.
func TestWindowOptionsColorFamilyName(t *testing.T) {
	for _, v := range []string{"red", "blue-dark"} {
		ops := &mockTmuxOps{}
		rec := postOptions(t, ops, "@2", `{"options":{"@rk_win_color":"`+v+`"}}`)

		if rec.Code != http.StatusOK {
			t.Fatalf("status(%q) = %d, want %d; body=%s", v, rec.Code, http.StatusOK, rec.Body.String())
		}
		op, ok := findOp(ops.setWindowOptionsOps, "@rk_win_color")
		if !ok || op.Value == nil || *op.Value != v {
			t.Errorf("@rk_win_color op = %+v, want value %q", op, v)
		}
	}
}

// Empty @rk_win_url → 400 and zero tmux calls.
// retire-with: legacy-option-key-translation
func TestWindowOptionsEmptyUrl(t *testing.T) {
	stubWebTabFamily(t, tmux.WebTabFamily{})
	ops := &mockTmuxOps{}
	rec := postOptions(t, ops, "@0", `{"options":{"@rk_win_url":""}}`)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusBadRequest)
	}
	if ops.setWindowOptionsCalled {
		t.Error("SetWindowOptions must NOT be called for empty url")
	}
}

// @rk_win_url scheme allowlist (R1): absolute http:/https: URLs and
// single-slash root-relative paths pass; javascript:/data:/file:,
// scheme-relative //…, bare hosts, backslash host escapes, and whitespace-only
// values are rejected with 400 and zero tmux calls. The
// retired key rides the compat translation onto @rk_win_web_1, so validation
// is the shared ValidateWebTabURL rule.
// retire-with: legacy-option-key-translation
func TestWindowOptionsRkURLSchemeAllowlist(t *testing.T) {
	stubWebTabFamily(t, tmux.WebTabFamily{})
	accepted := []string{
		"https://example.com",
		"https://example.com/path?q=1",
		"http://localhost:3000/x",
		"/proxy/3000/",
		"/present/@320/file.html?server=runKit&v=1",
		"/tutorial/ch1-orientation.html",
	}
	for _, url := range accepted {
		ops := &mockTmuxOps{}
		rec := postOptions(t, ops, "@0", fmt.Sprintf(`{"options":{"@rk_win_url":%q}}`, url))
		if rec.Code != http.StatusOK {
			t.Errorf("accept %q: status = %d, want %d; body=%s", url, rec.Code, http.StatusOK, rec.Body.String())
		}
	}

	rejected := []string{
		"javascript:alert(1)",
		"data:text/html,<script>alert(1)</script>",
		"file:///etc/passwd",
		"//evil.com/x",
		"ftp://example.com/x",
		"example.com",
		"localhost:3000",
		"   ",
		"https://",
		`/\evil.com/x`,
	}
	for _, url := range rejected {
		ops := &mockTmuxOps{}
		rec := postOptions(t, ops, "@0", fmt.Sprintf(`{"options":{"@rk_win_url":%q}}`, url))
		if rec.Code != http.StatusBadRequest {
			t.Errorf("reject %q: status = %d, want %d", url, rec.Code, http.StatusBadRequest)
		}
		if ops.setWindowOptionsCalled {
			t.Errorf("reject %q: SetWindowOptions must NOT be called", url)
		}
	}
}

// Unknown key → 400; the key is never forwarded to tmux. A mixed body (one
// valid + one invalid key) must also abort with zero tmux calls (atomic).
func TestWindowOptionsUnknownKeyRejected(t *testing.T) {
	ops := &mockTmuxOps{}
	rec := postOptions(t, ops, "@0", `{"options":{"@rk_win_color":"5","@evil":"x"}}`)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusBadRequest)
	}
	if ops.setWindowOptionsCalled {
		t.Error("SetWindowOptions must NOT be called when an unknown key is present")
	}
}

// The retired pre-rename names are NOT dual-accepted: the allowlist hard-cuts
// to the scope-prefixed names, so a legacy key in the body → 400 with zero
// tmux calls (writers switched at the rename; the tmux-side dual-read covers
// only out-of-band stampers).
func TestWindowOptionsLegacyKeysRejected(t *testing.T) {
	for _, key := range []string{"@rk_type", "@rk_url", "@rk_note", "@rk_marker", "@rk_flair", "@rk_role"} {
		ops := &mockTmuxOps{}
		rec := postOptions(t, ops, "@0", fmt.Sprintf(`{"options":{%q:"x"}}`, key))

		if rec.Code != http.StatusBadRequest {
			t.Errorf("legacy key %s: status = %d, want %d", key, rec.Code, http.StatusBadRequest)
		}
		if ops.setWindowOptionsCalled {
			t.Errorf("legacy key %s: SetWindowOptions must NOT be called", key)
		}
	}
}

// Set @rk_win_marker only — one SetWindowOptions call with just @rk_win_marker.
func TestWindowOptionsSetMarkerOnly(t *testing.T) {
	ops := &mockTmuxOps{}
	rec := postOptions(t, ops, "@2", `{"options":{"@rk_win_marker":"blocked:2"}}`)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body=%s", rec.Code, http.StatusOK, rec.Body.String())
	}
	if len(ops.setWindowOptionsOps) != 1 {
		t.Fatalf("ops = %v, want exactly 1 (@rk_win_marker)", ops.setWindowOptionsOps)
	}
	op, ok := findOp(ops.setWindowOptionsOps, "@rk_win_marker")
	if !ok || op.Value == nil || *op.Value != "blocked:2" {
		t.Errorf("@rk_win_marker op = %+v, want value \"blocked:2\"", op)
	}
}

// @rk_win_marker empty string unsets (nil Value op), mirroring the retired
// @rk_win_lens contract — "" clears.
func TestWindowOptionsMarkerEmptyUnsets(t *testing.T) {
	ops := &mockTmuxOps{}
	rec := postOptions(t, ops, "@2", `{"options":{"@rk_win_marker":""}}`)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusOK)
	}
	op, ok := findOp(ops.setWindowOptionsOps, "@rk_win_marker")
	if !ok {
		t.Fatal("expected @rk_win_marker op")
	}
	if op.Value != nil {
		t.Errorf("@rk_win_marker value = %q, want nil (empty string unsets)", *op.Value)
	}
}

// Invalid @rk_win_marker values return 400 and make zero tmux
// calls (validate-all-then-execute).
func TestWindowOptionsMarkerInvalid(t *testing.T) {
	ops := &mockTmuxOps{}
	rec := postOptions(t, ops, "@0", `{"options":{"@rk_win_marker":"wavy"}}`)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusBadRequest)
	}
	if ops.setWindowOptionsCalled {
		t.Error("SetWindowOptions must NOT be called for invalid marker")
	}
}

func TestWindowOptionsMarkerVocabulary(t *testing.T) {
	for _, v := range []string{"manual", "manual:1", "manual:2", "manual:3", "auto", "auto:1", "auto:2", "auto:3", "blocked", "blocked:1", "blocked:2", "blocked:3"} {
		ops := &mockTmuxOps{}
		rec := postOptions(t, ops, "@2", `{"options":{"@rk_win_marker":"`+v+`"}}`)

		if rec.Code != http.StatusOK {
			t.Fatalf("status(%q) = %d, want %d; body=%s", v, rec.Code, http.StatusOK, rec.Body.String())
		}
		op, ok := findOp(ops.setWindowOptionsOps, "@rk_win_marker")
		if !ok || op.Value == nil || *op.Value != v {
			t.Errorf("@rk_win_marker op = %+v, want value %q", op, v)
		}
	}

	for _, v := range []string{"pipe", "dotted", "dashed", "solid", "double", "thick", "hatch", "block"} {
		ops := &mockTmuxOps{}
		rec := postOptions(t, ops, "@2", `{"options":{"@rk_win_marker":"`+v+`"}}`)

		if rec.Code != http.StatusBadRequest {
			t.Errorf("status(%q) = %d, want %d; body=%s", v, rec.Code, http.StatusBadRequest, rec.Body.String())
		}
		if ops.setWindowOptionsCalled {
			t.Errorf("SetWindowOptions called for retired marker %q", v)
		}
	}
}

// Set @rk_win_flair only — one SetWindowOptions call with just @rk_win_flair.
func TestWindowOptionsSetFlairOnly(t *testing.T) {
	ops := &mockTmuxOps{}
	rec := postOptions(t, ops, "@2", `{"options":{"@rk_win_flair":"nyan"}}`)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body=%s", rec.Code, http.StatusOK, rec.Body.String())
	}
	if len(ops.setWindowOptionsOps) != 1 {
		t.Fatalf("ops = %v, want exactly 1 (@rk_win_flair)", ops.setWindowOptionsOps)
	}
	op, ok := findOp(ops.setWindowOptionsOps, "@rk_win_flair")
	if !ok || op.Value == nil || *op.Value != "nyan" {
		t.Errorf("@rk_win_flair op = %+v, want value \"nyan\"", op)
	}
}

// @rk_win_flair empty string unsets (nil Value op), mirroring @rk_win_marker — "" clears.
func TestWindowOptionsFlairEmptyUnsets(t *testing.T) {
	ops := &mockTmuxOps{}
	rec := postOptions(t, ops, "@2", `{"options":{"@rk_win_flair":""}}`)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusOK)
	}
	op, ok := findOp(ops.setWindowOptionsOps, "@rk_win_flair")
	if !ok {
		t.Fatal("expected @rk_win_flair op")
	}
	if op.Value != nil {
		t.Errorf("@rk_win_flair value = %q, want nil (empty string unsets)", *op.Value)
	}
}

// Invalid @rk_win_flair (outside the 3-state closed set) → 400 and zero tmux
// calls (validate-all-then-execute).
func TestWindowOptionsFlairInvalid(t *testing.T) {
	ops := &mockTmuxOps{}
	rec := postOptions(t, ops, "@0", `{"options":{"@rk_win_flair":"pikachu"}}`)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusBadRequest)
	}
	if ops.setWindowOptionsCalled {
		t.Error("SetWindowOptions must NOT be called for invalid flair")
	}
}

// Set @rk_win_owner=operator — one SetWindowOptions call with just
// @rk_win_owner.
func TestWindowOptionsSetOwner(t *testing.T) {
	ops := &mockTmuxOps{}
	rec := postOptions(t, ops, "@7", `{"options":{"@rk_win_owner":"operator"}}`)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body=%s", rec.Code, http.StatusOK, rec.Body.String())
	}
	op, ok := findOp(ops.setWindowOptionsOps, "@rk_win_owner")
	if !ok || op.Value == nil || *op.Value != "operator" {
		t.Errorf("@rk_win_owner op = %+v, want value \"operator\"", op)
	}
}

// @rk_win_owner empty string unsets (nil Value op), mirroring @rk_win_marker —
// "" clears.
func TestWindowOptionsOwnerEmptyUnsets(t *testing.T) {
	ops := &mockTmuxOps{}
	rec := postOptions(t, ops, "@7", `{"options":{"@rk_win_owner":""}}`)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusOK)
	}
	op, ok := findOp(ops.setWindowOptionsOps, "@rk_win_owner")
	if !ok {
		t.Fatal("expected @rk_win_owner op")
	}
	if op.Value != nil {
		t.Errorf("@rk_win_owner value = %q, want nil (empty string unsets)", *op.Value)
	}
}

// Invalid @rk_win_owner (outside the closed set) → 400 naming the accepted
// token, and zero tmux calls (validate-all-then-execute).
func TestWindowOptionsOwnerInvalid(t *testing.T) {
	ops := &mockTmuxOps{}
	rec := postOptions(t, ops, "@7", `{"options":{"@rk_win_owner":"done"}}`)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusBadRequest)
	}
	if !strings.Contains(rec.Body.String(), "operator") {
		t.Errorf("body = %s, want the closed set named", rec.Body.String())
	}
	if ops.setWindowOptionsCalled {
		t.Error("SetWindowOptions must NOT be called for invalid owner")
	}
}

// Set @rk_win_role=operator — one SetWindowOptions call carrying the role op, with
// the server-scoped radio clear issued first (keeping the target window).
func TestWindowOptionsSetRoleOperator(t *testing.T) {
	ops := &mockTmuxOps{}
	rec := postOptions(t, ops, "@7", `{"options":{"@rk_win_role":"operator"}}`)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body=%s", rec.Code, http.StatusOK, rec.Body.String())
	}
	if len(ops.setWindowOptionsOps) != 1 {
		t.Fatalf("ops = %v, want exactly 1 (@rk_win_role)", ops.setWindowOptionsOps)
	}
	op, ok := findOp(ops.setWindowOptionsOps, "@rk_win_role")
	if !ok || op.Value == nil || *op.Value != "operator" {
		t.Errorf("@rk_win_role op = %+v, want value \"operator\"", op)
	}
	if !ops.clearWindowRoleCalled {
		t.Error("ClearWindowRoleExceptOnServer was not called for a role set")
	}
	if ops.clearWindowRoleKeepID != "@7" {
		t.Errorf("radio clear keepID = %q, want %q", ops.clearWindowRoleKeepID, "@7")
	}
	// Physical promotion: the window is moved into the operator session.
	if !ops.moveInOperatorCalled {
		t.Error("MoveWindowIntoOperatorSessionOnServer was not called for a role set")
	}
	if ops.moveInOperatorWindowID != "@7" {
		t.Errorf("move-in windowID = %q, want %q", ops.moveInOperatorWindowID, "@7")
	}
}

// Setting operator with a displaced carrier demotes the displaced window out
// of the operator session before moving the new operator in.
func TestWindowOptionsSetRoleOperatorDemotesDisplaced(t *testing.T) {
	ops := &mockTmuxOps{clearWindowRoleResult: []string{"@3"}}
	rec := postOptions(t, ops, "@7", `{"options":{"@rk_win_role":"operator"}}`)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body=%s", rec.Code, http.StatusOK, rec.Body.String())
	}
	if !ops.demoteOperatorCalled {
		t.Error("DemoteWindowFromOperatorSessionOnServer was not called for the displaced carrier")
	}
	if ops.demoteOperatorWindowID != "@3" {
		t.Errorf("demote windowID = %q, want %q (the displaced carrier)", ops.demoteOperatorWindowID, "@3")
	}
	if !ops.moveInOperatorCalled || ops.moveInOperatorWindowID != "@7" {
		t.Errorf("move-in = (%v, %q), want (true, @7)", ops.moveInOperatorCalled, ops.moveInOperatorWindowID)
	}
}

// @rk_win_role empty string unsets (nil Value op), mirroring @rk_win_marker — and an
// unset must NOT trigger the radio clear (nothing is being marked).
func TestWindowOptionsRoleEmptyUnsets(t *testing.T) {
	ops := &mockTmuxOps{}
	rec := postOptions(t, ops, "@7", `{"options":{"@rk_win_role":""}}`)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusOK)
	}
	op, ok := findOp(ops.setWindowOptionsOps, "@rk_win_role")
	if !ok {
		t.Fatal("expected @rk_win_role op")
	}
	if op.Value != nil {
		t.Errorf("@rk_win_role value = %q, want nil (empty string unsets)", *op.Value)
	}
	if ops.clearWindowRoleCalled {
		t.Error("ClearWindowRoleExceptOnServer must NOT be called for a role unset")
	}
	// A role clear demotes a member out of the operator session (a no-op move
	// for non-members).
	if !ops.demoteOperatorCalled {
		t.Error("DemoteWindowFromOperatorSessionOnServer was not called for a role unset")
	}
	if ops.demoteOperatorWindowID != "@7" {
		t.Errorf("demote windowID = %q, want %q", ops.demoteOperatorWindowID, "@7")
	}
	if ops.moveInOperatorCalled {
		t.Error("MoveWindowIntoOperatorSessionOnServer must NOT be called for a role unset")
	}
}

// Explicit null unsets @rk_win_role (partial-merge contract) without a radio clear.
func TestWindowOptionsRoleNullUnsets(t *testing.T) {
	ops := &mockTmuxOps{}
	rec := postOptions(t, ops, "@7", `{"options":{"@rk_win_role":null}}`)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusOK)
	}
	op, ok := findOp(ops.setWindowOptionsOps, "@rk_win_role")
	if !ok || op.Value != nil {
		t.Errorf("@rk_win_role op = %+v, want nil value (null unsets)", op)
	}
	if ops.clearWindowRoleCalled {
		t.Error("ClearWindowRoleExceptOnServer must NOT be called for a role unset")
	}
}

// Invalid @rk_win_role (outside the closed set) → 400 and zero tmux calls
// (validate-all-then-execute).
func TestWindowOptionsRoleInvalid(t *testing.T) {
	ops := &mockTmuxOps{}
	rec := postOptions(t, ops, "@7", `{"options":{"@rk_win_role":"manager"}}`)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusBadRequest)
	}
	if ops.setWindowOptionsCalled {
		t.Error("SetWindowOptions must NOT be called for invalid role")
	}
	if ops.clearWindowRoleCalled {
		t.Error("ClearWindowRoleExceptOnServer must NOT be called for invalid role")
	}
}

// @rk_win_lens is the retired compat key: "iframe" translates to
// @rk_win_layout=web ONLY when the window carries no layout; every
// other value, null, and the already-laid-out case are no-ops (nothing
// reaches tmux). The empty string is not "iframe", so it no-ops too — there
// is no longer a lens option to unset.
// retire-with: legacy-option-key-translation
func TestWindowOptionsRkTypeEmptyUnsets(t *testing.T) {
	stubWebTabFamily(t, tmux.WebTabFamily{})
	ops := &mockTmuxOps{}
	rec := postOptions(t, ops, "@2", `{"options":{"@rk_win_lens":""}}`)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusOK)
	}
	if ops.setWindowOptionsCalled {
		t.Errorf("empty @rk_win_lens is a no-op, but SetWindowOptions was called: %v", ops.setWindowOptionsOps)
	}
}

// retire-with: legacy-option-key-translation
func TestWindowOptionsRkTypeNullUnsets(t *testing.T) {
	stubWebTabFamily(t, tmux.WebTabFamily{})
	ops := &mockTmuxOps{}
	rec := postOptions(t, ops, "@2", `{"options":{"@rk_win_lens":null}}`)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusOK)
	}
	if ops.setWindowOptionsCalled {
		t.Errorf("null @rk_win_lens is a no-op, but SetWindowOptions was called: %v", ops.setWindowOptionsOps)
	}
}

// retire-with: legacy-option-key-translation
func TestWindowOptionsRkTypeSetVerbatim(t *testing.T) {
	stubWebTabFamily(t, tmux.WebTabFamily{})
	ops := &mockTmuxOps{}
	rec := postOptions(t, ops, "@2", `{"options":{"@rk_win_lens":"iframe"}}`)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusOK)
	}
	op, ok := findOp(ops.setWindowOptionsOps, "@rk_win_layout")
	if !ok || op.Value == nil || *op.Value != "web" {
		t.Errorf("@rk_win_layout op = %+v, want value \"web\" (translated from @rk_win_lens=iframe)", op)
	}
	if _, ok := findOp(ops.setWindowOptionsOps, "@rk_win_lens"); ok {
		t.Error("retired @rk_win_lens must never reach tmux")
	}
}

// The lens→layout translation never clobbers an existing @rk_win_layout
// (compat reads the family first).
// retire-with: legacy-option-key-translation
func TestWindowOptionsRkLensKeepsExistingLayout(t *testing.T) {
	stubWebTabFamily(t, tmux.WebTabFamily{Layout: "row:tty,code,web"})
	ops := &mockTmuxOps{}
	rec := postOptions(t, ops, "@2", `{"options":{"@rk_win_lens":"iframe"}}`)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusOK)
	}
	if ops.setWindowOptionsCalled {
		t.Errorf("_lens=iframe with an existing _layout must be a no-op, but ops ran: %v", ops.setWindowOptionsOps)
	}
}

// --- Live-in-one-place check on @rk_win_layout writes ---
//
// A layout write introducing a foreign leaf already held by a third window is
// a 409 naming the holder; a write re-using the writer's OWN holding, or an
// unheld leaf, passes. The server window set rides the session fetcher seam.

func postOptionsWithWindows(t *testing.T, ops *mockTmuxOps, windows []tmux.WindowInfo, windowID, body string) *httptest.ResponseRecorder {
	t.Helper()
	fetcher := &mockSessionFetcher{result: []sessions.ProjectSession{{Name: "s", Windows: windows}}}
	router := newTestRouter(fetcher, ops)
	req := httptest.NewRequest(http.MethodPost, "/api/windows/"+windowID+"/options", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	return rec
}

func heldLayoutWindows() []tmux.WindowInfo {
	return []tmux.WindowInfo{
		{WindowID: "@3", Layout: "tty"},
		{WindowID: "@7", Layout: "h(tty,@3/tty)"},
		{WindowID: "@9", Layout: "tty"},
	}
}

func TestWindowOptionsLayoutHeldByThirdWindow409(t *testing.T) {
	ops := &mockTmuxOps{}
	rec := postOptionsWithWindows(t, ops, heldLayoutWindows(), "@9", `{"options":{"@rk_win_layout":"h(tty,@3/tty)"}}`)

	if rec.Code != http.StatusConflict {
		t.Fatalf("status = %d, want %d; body=%s", rec.Code, http.StatusConflict, rec.Body.String())
	}
	var result map[string]string
	if err := json.NewDecoder(rec.Body).Decode(&result); err != nil {
		t.Fatalf("decode error: %v", err)
	}
	if !strings.Contains(result["error"], "@7") || !strings.Contains(result["error"], "@3/tty") {
		t.Errorf("error = %q, want it naming the leaf @3/tty and its holder @7", result["error"])
	}
	if !strings.Contains(result["error"], "borrow") {
		t.Errorf("error = %q, want it directing the caller to borrow", result["error"])
	}
	if ops.setWindowOptionsCalled {
		t.Error("a refused layout write must not reach tmux")
	}
}

func TestWindowOptionsLayoutSelfHeldPasses(t *testing.T) {
	ops := &mockTmuxOps{}
	// @7 already holds @3/tty; rewriting a layout that keeps its own holding
	// is not a conflict.
	rec := postOptionsWithWindows(t, ops, heldLayoutWindows(), "@7", `{"options":{"@rk_win_layout":"h(tty,@3/tty)"}}`)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body=%s", rec.Code, http.StatusOK, rec.Body.String())
	}
	if !ops.setWindowOptionsCalled {
		t.Error("a self-held rewrite must reach tmux")
	}
}

func TestWindowOptionsLayoutUnheldLeafPasses(t *testing.T) {
	ops := &mockTmuxOps{}
	// @3's web surface is held by nobody — @9 may take it.
	rec := postOptionsWithWindows(t, ops, heldLayoutWindows(), "@9", `{"options":{"@rk_win_layout":"h(tty,@3/web)"}}`)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body=%s", rec.Code, http.StatusOK, rec.Body.String())
	}
	if !ops.setWindowOptionsCalled {
		t.Error("an unheld foreign-leaf write must reach tmux")
	}
}

func TestWindowOptionsLayoutSelfWindowLeaf400(t *testing.T) {
	ops := &mockTmuxOps{}
	rec := postOptionsWithWindows(t, ops, heldLayoutWindows(), "@9", `{"options":{"@rk_win_layout":"h(tty,@9/tty)"}}`)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d; body=%s", rec.Code, http.StatusBadRequest, rec.Body.String())
	}
	if ops.setWindowOptionsCalled {
		t.Error("a self-naming leaf must not reach tmux")
	}
}

func TestWindowRouteGuards(t *testing.T) {
	cases := []struct {
		name      string
		path      string
		body      string
		wantError string
		touched   func(*mockTmuxOps) bool
	}{
		{name: "options invalid window ID", path: "/api/windows/abc/options", body: `{"options":{"@rk_win_color":"5"}}`, touched: func(ops *mockTmuxOps) bool { return ops.setWindowOptionsCalled }},
		{name: "select invalid window ID", path: "/api/windows/abc/select", touched: func(ops *mockTmuxOps) bool { return ops.selectWindowInSessionCalled }},
		{name: "kill invalid window ID", path: "/api/windows/abc/kill", wantError: "Invalid window ID", touched: func(ops *mockTmuxOps) bool { return ops.killWindowCalled }},
		{name: "split invalid window ID", path: "/api/windows/bad;name/split", body: `{"horizontal":false}`, touched: func(ops *mockTmuxOps) bool { return ops.splitWindowCalled }},
		{name: "move invalid window ID", path: "/api/windows/abc/move", body: `{"targetIndex":2}`, wantError: "Invalid window ID", touched: func(ops *mockTmuxOps) bool { return ops.swapWindowCalled }},
		{name: "split invalid JSON", path: "/api/windows/@0/split", body: "not json", touched: func(ops *mockTmuxOps) bool { return ops.splitWindowCalled }},
		{name: "move-to-session invalid window ID", path: "/api/windows/bad;session/move-to-session", body: `{"targetSession":"bravo"}`, touched: func(ops *mockTmuxOps) bool { return ops.moveWindowToSessionCalled }},
		{name: "move-to-session invalid JSON", path: "/api/windows/@0/move-to-session", body: "not json", wantError: "Invalid JSON body", touched: func(ops *mockTmuxOps) bool { return ops.moveWindowToSessionCalled }},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			ops := &mockTmuxOps{}
			router := newTestRouter(&mockSessionFetcher{}, ops)
			req := httptest.NewRequest(http.MethodPost, tc.path, strings.NewReader(tc.body))
			req.Header.Set("Content-Type", "application/json")
			rec := httptest.NewRecorder()
			router.ServeHTTP(rec, req)

			if rec.Code != http.StatusBadRequest {
				t.Errorf("status = %d, want %d", rec.Code, http.StatusBadRequest)
			}
			if tc.touched(ops) {
				t.Error("tmux operation must not run for an invalid request")
			}
			if tc.wantError != "" {
				var result map[string]string
				if err := json.NewDecoder(rec.Body).Decode(&result); err != nil {
					t.Fatalf("decode error: %v", err)
				}
				if result["error"] != tc.wantError {
					t.Errorf("error = %q, want %q", result["error"], tc.wantError)
				}
			}
		})
	}
}

// --- /select re-route tests (POST /api/windows/{id}/select) ---
//
// The handler must resolve the owning session and issue SelectWindowInSession
// (scoped); the bare SelectWindow variant no longer exists.
func TestWindowSelectResolvesSession(t *testing.T) {
	ops := &mockTmuxOps{resolveWindowSessionResult: "real-session"}
	router := newTestRouter(&mockSessionFetcher{}, ops)

	req := httptest.NewRequest(http.MethodPost, "/api/windows/@2/select", nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body=%s", rec.Code, http.StatusOK, rec.Body.String())
	}
	if ops.resolveWindowSessionID != "@2" {
		t.Errorf("ResolveWindowSession id = %q, want %q", ops.resolveWindowSessionID, "@2")
	}
	if !ops.selectWindowInSessionCalled {
		t.Fatal("SelectWindowInSession was not called")
	}
	if ops.selectWindowInSessionSession != "real-session" {
		t.Errorf("scoped session = %q, want %q", ops.selectWindowInSessionSession, "real-session")
	}
	if ops.selectWindowInSessionWindowID != "@2" {
		t.Errorf("scoped windowID = %q, want %q", ops.selectWindowInSessionWindowID, "@2")
	}
}

// A successful select returns the post-select active window id, read from tmux
// after the select executed (session-scoped exact-match read).
func TestWindowSelectReturnsActiveWindow(t *testing.T) {
	ops := &mockTmuxOps{
		resolveWindowSessionResult: "real-session",
		activeWindowIDResult:       "@2",
	}
	router := newTestRouter(&mockSessionFetcher{}, ops)

	req := httptest.NewRequest(http.MethodPost, "/api/windows/@2/select", nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body=%s", rec.Code, http.StatusOK, rec.Body.String())
	}
	var body struct {
		OK           bool   `json:"ok"`
		ActiveWindow string `json:"activeWindow"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode body: %v", err)
	}
	if !body.OK {
		t.Error("body.ok = false, want true")
	}
	if body.ActiveWindow != "@2" {
		t.Errorf("body.activeWindow = %q, want %q", body.ActiveWindow, "@2")
	}
	if ops.activeWindowIDSession != "real-session" {
		t.Errorf("ActiveWindowID session = %q, want %q", ops.activeWindowIDSession, "real-session")
	}
}

// A failed post-select active-window read falls back to the requested window
// id — the select itself succeeded, so the read must never fail the request.
func TestWindowSelectActiveWindowReadFailureFallsBack(t *testing.T) {
	ops := &mockTmuxOps{
		resolveWindowSessionResult: "real-session",
		activeWindowIDErr:          fmt.Errorf("display-message failed"),
	}
	router := newTestRouter(&mockSessionFetcher{}, ops)

	req := httptest.NewRequest(http.MethodPost, "/api/windows/@2/select", nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d (read failure must not fail the request); body=%s", rec.Code, http.StatusOK, rec.Body.String())
	}
	var body struct {
		OK           bool   `json:"ok"`
		ActiveWindow string `json:"activeWindow"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode body: %v", err)
	}
	if body.ActiveWindow != "@2" {
		t.Errorf("body.activeWindow = %q, want fallback %q", body.ActiveWindow, "@2")
	}
}

// A resolve failure (stale @N) surfaces a non-2xx error and issues no select.
func TestWindowSelectResolveFailure(t *testing.T) {
	ops := &mockTmuxOps{resolveWindowSessionErr: fmt.Errorf("window @99 not found")}
	router := newTestRouter(&mockSessionFetcher{}, ops)

	req := httptest.NewRequest(http.MethodPost, "/api/windows/@99/select", nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code < 400 {
		t.Errorf("status = %d, want non-2xx", rec.Code)
	}
	if ops.selectWindowInSessionCalled {
		t.Error("SelectWindowInSession must NOT be called on resolve failure")
	}
}

// --- decodeWindowID coverage ---
//
// decodeWindowID is exercised through the window handlers (it backs
// parseWindowID). %402 → @2 succeeds; a bare number and a non-@ id are rejected
// with 400 before any tmux call.
func TestDecodeWindowID(t *testing.T) {
	cases := []struct {
		name     string
		raw      string // raw path segment (already percent-encoded as a client would send)
		wantCode int
		wantID   string // expected windowID passed to tmux on success
	}{
		{"percent-encoded at", "%402", http.StatusOK, "@2"},
		{"bare number rejected", "2", http.StatusBadRequest, ""},
		{"non-window id rejected", "abc", http.StatusBadRequest, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			ops := &mockTmuxOps{}
			router := newTestRouter(&mockSessionFetcher{}, ops)
			req := httptest.NewRequest(http.MethodPost, "/api/windows/"+tc.raw+"/kill", nil)
			rec := httptest.NewRecorder()
			router.ServeHTTP(rec, req)

			if rec.Code != tc.wantCode {
				t.Fatalf("status = %d, want %d", rec.Code, tc.wantCode)
			}
			if tc.wantCode == http.StatusOK {
				if ops.killWindowID != tc.wantID {
					t.Errorf("decoded windowID = %q, want %q", ops.killWindowID, tc.wantID)
				}
			} else if ops.killWindowCalled {
				t.Error("tmux KillWindow must NOT be called when decode/validate fails")
			}
		})
	}
}

func TestWindowCreate(t *testing.T) {
	ops := &mockTmuxOps{}
	router := newTestRouter(&mockSessionFetcher{}, ops)

	body := `{"name":"feature","cwd":"~/code/run-kit"}`
	req := httptest.NewRequest(http.MethodPost, "/api/sessions/run-kit/windows", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusCreated {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusCreated)
	}

	if !ops.createWindowCalled {
		t.Error("CreateWindow was not called")
	}
	if ops.createWindowSession != "run-kit" {
		t.Errorf("session = %q, want %q", ops.createWindowSession, "run-kit")
	}
	if ops.createWindowName != "feature" {
		t.Errorf("name = %q, want %q", ops.createWindowName, "feature")
	}
}

func TestWindowCreateDefaultCwdFromFirstWindow(t *testing.T) {
	ops := &mockTmuxOps{
		listWindowsResult: []tmux.WindowInfo{
			{Index: 0, Name: "main", WorktreePath: "/home/user/project"},
			{Index: 1, Name: "tests", WorktreePath: "/home/user/other"},
		},
	}
	router := newTestRouter(&mockSessionFetcher{}, ops)

	body := `{"name":"new-win"}`
	req := httptest.NewRequest(http.MethodPost, "/api/sessions/run-kit/windows", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusCreated {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusCreated)
	}
	if ops.createWindowCwd != "/home/user/project" {
		t.Errorf("cwd = %q, want %q", ops.createWindowCwd, "/home/user/project")
	}
}

func TestWindowCreateInvalidSession(t *testing.T) {
	router := newTestRouter(&mockSessionFetcher{}, &mockTmuxOps{})

	body := `{"name":"win"}`
	req := httptest.NewRequest(http.MethodPost, "/api/sessions/bad;session/windows", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusBadRequest)
	}
}

// An omitted/empty window name is now valid on CREATE — it means "let tmux
// auto-name the window to its folder basename". The handler accepts it (201)
// and calls CreateWindow with an empty name (tmux.CreateWindow then omits the
// -n token). This is the spec change for 260707-j66b.
func TestWindowCreateEmptyNameAccepted(t *testing.T) {
	ops := &mockTmuxOps{}
	router := newTestRouter(&mockSessionFetcher{}, ops)

	body := `{"name":"","cwd":"~/code/run-kit"}`
	req := httptest.NewRequest(http.MethodPost, "/api/sessions/run-kit/windows", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusCreated {
		t.Errorf("status = %d, want %d; body=%s", rec.Code, http.StatusCreated, rec.Body.String())
	}
	if !ops.createWindowCalled {
		t.Error("CreateWindow was not called")
	}
	if ops.createWindowName != "" {
		t.Errorf("name = %q, want empty string (tmux auto-names)", ops.createWindowName)
	}
}

// An omitted "name" key (body without name at all) is equally valid.
func TestWindowCreateOmittedNameAccepted(t *testing.T) {
	ops := &mockTmuxOps{}
	router := newTestRouter(&mockSessionFetcher{}, ops)

	body := `{"cwd":"~/code/run-kit"}`
	req := httptest.NewRequest(http.MethodPost, "/api/sessions/run-kit/windows", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusCreated {
		t.Errorf("status = %d, want %d; body=%s", rec.Code, http.StatusCreated, rec.Body.String())
	}
	if !ops.createWindowCalled {
		t.Error("CreateWindow was not called")
	}
	if ops.createWindowName != "" {
		t.Errorf("name = %q, want empty string (tmux auto-names)", ops.createWindowName)
	}
}

// A NON-EMPTY name is still validated on CREATE — forbidden characters return
// 400 and issue no tmux call (only the empty case is relaxed).
func TestWindowCreateNonEmptyInvalidNameRejected(t *testing.T) {
	ops := &mockTmuxOps{}
	router := newTestRouter(&mockSessionFetcher{}, ops)

	body := `{"name":"bad;name"}`
	req := httptest.NewRequest(http.MethodPost, "/api/sessions/run-kit/windows", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusBadRequest)
	}
	if ops.createWindowCalled {
		t.Error("CreateWindow must NOT be called for an invalid non-empty name")
	}
}

func TestWindowCreateSpaceyNameRejected(t *testing.T) {
	// The tightened new-name rule (validate.ValidateNewName) applies to a
	// non-empty to-be-created window name.
	ops := &mockTmuxOps{}
	router := newTestRouter(&mockSessionFetcher{}, ops)

	body := `{"name":"my window"}`
	req := httptest.NewRequest(http.MethodPost, "/api/sessions/run-kit/windows", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusBadRequest)
	}
	if ops.createWindowCalled {
		t.Error("CreateWindow must NOT be called for a spacey name")
	}
}

func TestWindowKill(t *testing.T) {
	ops := &mockTmuxOps{}
	router := newTestRouter(&mockSessionFetcher{}, ops)

	req := httptest.NewRequest(http.MethodPost, "/api/windows/@1/kill", nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusOK)
	}

	if !ops.killWindowCalled {
		t.Error("KillWindow was not called")
	}
	if ops.killWindowID != "@1" {
		t.Errorf("windowID = %q, want %q", ops.killWindowID, "@1")
	}
}

// Regression: clients URL-encode '@' as '%40' in path segments via
// encodeURIComponent. chi v5 preserves the encoded form in URLParam, so the
// handler must percent-decode before validating the window ID.
func TestWindowKillPercentEncodedAt(t *testing.T) {
	ops := &mockTmuxOps{}
	router := newTestRouter(&mockSessionFetcher{}, ops)

	req := httptest.NewRequest(http.MethodPost, "/api/windows/%4018/kill", nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("status = %d, want %d (body: %s)", rec.Code, http.StatusOK, rec.Body.String())
	}
	if ops.killWindowID != "@18" {
		t.Errorf("windowID = %q, want %q", ops.killWindowID, "@18")
	}
}

func TestWindowKillBareNumberRejected(t *testing.T) {
	router := newTestRouter(&mockSessionFetcher{}, &mockTmuxOps{})

	// A bare numeric segment (the old index form) is no longer a valid window ID.
	req := httptest.NewRequest(http.MethodPost, "/api/windows/1/kill", nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusBadRequest)
	}
}

func TestWindowRename(t *testing.T) {
	ops := &mockTmuxOps{}
	router := newTestRouter(&mockSessionFetcher{}, ops)

	body := `{"name":"new-name"}`
	req := httptest.NewRequest(http.MethodPost, "/api/windows/@1/rename", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusOK)
	}

	if !ops.renameWindowCalled {
		t.Error("RenameWindow was not called")
	}
	if ops.renameWindowWindowID != "@1" {
		t.Errorf("windowID = %q, want %q", ops.renameWindowWindowID, "@1")
	}
	if ops.renameWindowName != "new-name" {
		t.Errorf("name = %q, want %q", ops.renameWindowName, "new-name")
	}
}

func TestWindowRenameEmptyName(t *testing.T) {
	router := newTestRouter(&mockSessionFetcher{}, &mockTmuxOps{})

	body := `{"name":""}`
	req := httptest.NewRequest(http.MethodPost, "/api/windows/@0/rename", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusBadRequest)
	}
}

func TestWindowRenameSpaceyNameRejected(t *testing.T) {
	// The renamed-TO window name is held to the tightened rule.
	ops := &mockTmuxOps{}
	router := newTestRouter(&mockSessionFetcher{}, ops)

	body := `{"name":"my window"}`
	req := httptest.NewRequest(http.MethodPost, "/api/windows/@1/rename", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusBadRequest)
	}
	if ops.renameWindowCalled {
		t.Error("RenameWindow must NOT be called for a spacey name")
	}
}

func TestWindowKeys(t *testing.T) {
	ops := &mockTmuxOps{}
	router := newTestRouter(&mockSessionFetcher{}, ops)

	body := `{"keys":"echo hello"}`
	req := httptest.NewRequest(http.MethodPost, "/api/windows/@0/keys", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusOK)
	}

	if !ops.sendKeysCalled {
		t.Error("SendKeys was not called")
	}
	if ops.sendKeysWindowID != "@0" {
		t.Errorf("windowID = %q, want %q", ops.sendKeysWindowID, "@0")
	}
	if ops.sendKeysKeys != "echo hello" {
		t.Errorf("keys = %q, want %q", ops.sendKeysKeys, "echo hello")
	}
}

func TestWindowKeysEmpty(t *testing.T) {
	router := newTestRouter(&mockSessionFetcher{}, &mockTmuxOps{})

	body := `{"keys":"  "}`
	req := httptest.NewRequest(http.MethodPost, "/api/windows/@0/keys", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusBadRequest)
	}

	var result map[string]string
	if err := json.NewDecoder(rec.Body).Decode(&result); err != nil {
		t.Fatalf("decode error: %v", err)
	}
	if result["error"] != "Keys cannot be empty" {
		t.Errorf("error = %q, want %q", result["error"], "Keys cannot be empty")
	}
}

func TestWindowSplit(t *testing.T) {
	ops := &mockTmuxOps{splitWindowResult: "%5"}
	router := newTestRouter(&mockSessionFetcher{}, ops)

	body := `{"horizontal":true}`
	req := httptest.NewRequest(http.MethodPost, "/api/windows/@0/split", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusOK)
	}

	if !ops.splitWindowCalled {
		t.Error("SplitWindow was not called")
	}
	if ops.splitWindowID != "@0" {
		t.Errorf("windowID = %q, want %q", ops.splitWindowID, "@0")
	}
	if !ops.splitWindowHorizontal {
		t.Error("horizontal = false, want true")
	}
	if !ops.selectPaneCalled {
		t.Error("SelectPane was not called")
	}
	if ops.selectPanePaneID != "%5" {
		t.Errorf("SelectPane paneID = %q, want %%5", ops.selectPanePaneID)
	}
	if ops.selectPaneServer != "default" {
		t.Errorf("SelectPane server = %q, want %q", ops.selectPaneServer, "default")
	}

	var result map[string]any
	if err := json.NewDecoder(rec.Body).Decode(&result); err != nil {
		t.Fatalf("decode error: %v", err)
	}
	if result["pane_id"] != "%5" {
		t.Errorf("pane_id = %q, want %%5", result["pane_id"])
	}
}

func TestWindowSplitSelectPaneError(t *testing.T) {
	ops := &mockTmuxOps{splitWindowResult: "%7", selectPaneErr: errors.New("select failed")}
	router := newTestRouter(&mockSessionFetcher{}, ops)

	body := `{"horizontal":true}`
	req := httptest.NewRequest(http.MethodPost, "/api/windows/@0/split", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusOK)
	}

	var result map[string]any
	if err := json.NewDecoder(rec.Body).Decode(&result); err != nil {
		t.Fatalf("decode error: %v", err)
	}
	if result["ok"] != true {
		t.Error("expected ok: true despite SelectPane error")
	}
	if result["pane_id"] != "%7" {
		t.Errorf("pane_id = %q, want %%7", result["pane_id"])
	}
}

func TestWindowSplitError(t *testing.T) {
	ops := &mockTmuxOps{splitWindowErr: errors.New("split failed")}
	router := newTestRouter(&mockSessionFetcher{}, ops)

	body := `{"horizontal":false}`
	req := httptest.NewRequest(http.MethodPost, "/api/windows/@0/split", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusInternalServerError {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusInternalServerError)
	}
	if ops.selectPaneCalled {
		t.Error("SelectPane was called after a failed split")
	}
}

func TestWindowMoveSuccess(t *testing.T) {
	ops := &mockTmuxOps{}
	router := newTestRouter(&mockSessionFetcher{}, ops)

	body := `{"targetIndex":2}`
	req := httptest.NewRequest(http.MethodPost, "/api/windows/@5/move", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusOK)
	}

	if !ops.swapWindowCalled {
		t.Error("MoveWindow was not called")
	}
	if ops.swapWindowID != "@5" {
		t.Errorf("windowID = %q, want %q", ops.swapWindowID, "@5")
	}
	if ops.swapWindowDstIndex != 2 {
		t.Errorf("dstIndex = %d, want %d", ops.swapWindowDstIndex, 2)
	}

	var result map[string]bool
	if err := json.NewDecoder(rec.Body).Decode(&result); err != nil {
		t.Fatalf("decode error: %v", err)
	}
	if !result["ok"] {
		t.Error("expected ok: true")
	}
}

func TestWindowMoveInvalidBody(t *testing.T) {
	router := newTestRouter(&mockSessionFetcher{}, &mockTmuxOps{})

	req := httptest.NewRequest(http.MethodPost, "/api/windows/@0/move", strings.NewReader("not json"))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusBadRequest)
	}

	var result map[string]string
	if err := json.NewDecoder(rec.Body).Decode(&result); err != nil {
		t.Fatalf("decode error: %v", err)
	}
	if result["error"] != "Invalid JSON body" {
		t.Errorf("error = %q, want %q", result["error"], "Invalid JSON body")
	}
}

func TestWindowMoveNegativeTargetIndex(t *testing.T) {
	router := newTestRouter(&mockSessionFetcher{}, &mockTmuxOps{})

	body := `{"targetIndex":-1}`
	req := httptest.NewRequest(http.MethodPost, "/api/windows/@0/move", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusBadRequest)
	}

	var result map[string]string
	if err := json.NewDecoder(rec.Body).Decode(&result); err != nil {
		t.Fatalf("decode error: %v", err)
	}
	if result["error"] != "targetIndex must be a non-negative integer" {
		t.Errorf("error = %q, want %q", result["error"], "targetIndex must be a non-negative integer")
	}
}

func TestWindowMoveTmuxError(t *testing.T) {
	ops := &mockTmuxOps{swapWindowErr: fmt.Errorf("can't find window 5")}
	router := newTestRouter(&mockSessionFetcher{}, ops)

	body := `{"targetIndex":5}`
	req := httptest.NewRequest(http.MethodPost, "/api/windows/@0/move", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusInternalServerError {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusInternalServerError)
	}
}

func TestWindowMoveMissingTargetIndex(t *testing.T) {
	router := newTestRouter(&mockSessionFetcher{}, &mockTmuxOps{})

	body := `{}`
	req := httptest.NewRequest(http.MethodPost, "/api/windows/@0/move", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusBadRequest)
	}
}

// --- MoveWindowToSession handler tests ---

func TestWindowMoveToSessionSuccess(t *testing.T) {
	ops := &mockTmuxOps{}
	router := newTestRouter(&mockSessionFetcher{}, ops)

	body := `{"targetSession":"bravo"}`
	req := httptest.NewRequest(http.MethodPost, "/api/windows/@1/move-to-session", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusOK)
	}

	if !ops.moveWindowToSessionCalled {
		t.Error("MoveWindowToSession was not called")
	}
	if ops.moveWindowToSessionWindowID != "@1" {
		t.Errorf("windowID = %q, want %q", ops.moveWindowToSessionWindowID, "@1")
	}
	if ops.moveWindowToSessionDstSession != "bravo" {
		t.Errorf("dstSession = %q, want %q", ops.moveWindowToSessionDstSession, "bravo")
	}

	var result map[string]bool
	if err := json.NewDecoder(rec.Body).Decode(&result); err != nil {
		t.Fatalf("decode error: %v", err)
	}
	if !result["ok"] {
		t.Error("expected ok: true")
	}
}

func TestWindowMoveToSessionMissingTarget(t *testing.T) {
	router := newTestRouter(&mockSessionFetcher{}, &mockTmuxOps{})

	body := `{}`
	req := httptest.NewRequest(http.MethodPost, "/api/windows/@0/move-to-session", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusBadRequest)
	}

	var result map[string]string
	if err := json.NewDecoder(rec.Body).Decode(&result); err != nil {
		t.Fatalf("decode error: %v", err)
	}
	if result["error"] != "targetSession is required" {
		t.Errorf("error = %q, want %q", result["error"], "targetSession is required")
	}
}

func TestWindowMoveToSessionInvalidTargetName(t *testing.T) {
	router := newTestRouter(&mockSessionFetcher{}, &mockTmuxOps{})

	body := `{"targetSession":"bad;name"}`
	req := httptest.NewRequest(http.MethodPost, "/api/windows/@0/move-to-session", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusBadRequest)
	}

	var result map[string]string
	if err := json.NewDecoder(rec.Body).Decode(&result); err != nil {
		t.Fatalf("decode error: %v", err)
	}
	if !strings.Contains(result["error"], "forbidden characters") {
		t.Errorf("error = %q, want containing %q", result["error"], "forbidden characters")
	}
}

func TestWindowMoveToSessionTmuxError(t *testing.T) {
	ops := &mockTmuxOps{moveWindowToSessionErr: fmt.Errorf("can't find window 99")}
	router := newTestRouter(&mockSessionFetcher{}, ops)

	body := `{"targetSession":"bravo"}`
	req := httptest.NewRequest(http.MethodPost, "/api/windows/@99/move-to-session", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusInternalServerError {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusInternalServerError)
	}
}

// --- Extended Window Creation tests ---

func TestWindowCreateWithIframeType(t *testing.T) {
	ops := &mockTmuxOps{}
	router := newTestRouter(&mockSessionFetcher{}, ops)

	body := `{"name":"docs","rkType":"iframe","rkUrl":"http://localhost:8080/docs"}`
	req := httptest.NewRequest(http.MethodPost, "/api/sessions/dev/windows", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusCreated {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusCreated)
	}

	if !ops.createWindowWithOptionsCalled {
		t.Error("CreateWindowWithOptions was not called")
	}
	if ops.createWindowWithOptionsSession != "dev" {
		t.Errorf("session = %q, want %q", ops.createWindowWithOptionsSession, "dev")
	}
	if ops.createWindowWithOptionsName != "docs" {
		t.Errorf("name = %q, want %q", ops.createWindowWithOptionsName, "docs")
	}
	// The iframe body is retargeted onto the indexed web-tab family
	// (layout=web + web_1 + web_active=1) — no @rk_win_lens/@rk_win_url.
	layoutOp, ok := findOp(ops.createWindowWithOptionsOps, "@rk_win_layout")
	if !ok || layoutOp.Value == nil || *layoutOp.Value != "web" {
		t.Errorf("@rk_win_layout op = %+v, want value \"web\"", layoutOp)
	}
	urlOp, ok := findOp(ops.createWindowWithOptionsOps, "@rk_win_web_1")
	if !ok || urlOp.Value == nil || *urlOp.Value != "http://localhost:8080/docs" {
		t.Errorf("@rk_win_web_1 op = %+v, want value \"http://localhost:8080/docs\"", urlOp)
	}
	activeOp, ok := findOp(ops.createWindowWithOptionsOps, "@rk_win_web_active")
	if !ok || activeOp.Value == nil || *activeOp.Value != "1" {
		t.Errorf("@rk_win_web_active op = %+v, want value \"1\"", activeOp)
	}
	if _, ok := findOp(ops.createWindowWithOptionsOps, "@rk_win_lens"); ok {
		t.Error("retired @rk_win_lens must NOT be written")
	}
	if _, ok := findOp(ops.createWindowWithOptionsOps, "@rk_win_url"); ok {
		t.Error("retired @rk_win_url must NOT be written")
	}
}

// The rkType (typed-window) create path pins an explicit name — CreateWindowWithOptions
// runs `new-window -n <name>` with automatic-rename disabled, so an empty name would
// strand the window on an empty name. Unlike the plain terminal create (which omits -n
// and lets tmux auto-name), a name is REQUIRED here: an empty/omitted name returns 400
// and CreateWindowWithOptions is never called. This is the R10 hardening for 260707-j66b.
func TestWindowCreateIframeEmptyNameRejected(t *testing.T) {
	ops := &mockTmuxOps{}
	router := newTestRouter(&mockSessionFetcher{}, ops)

	body := `{"name":"","rkType":"iframe","rkUrl":"http://localhost:8080/docs"}`
	req := httptest.NewRequest(http.MethodPost, "/api/sessions/dev/windows", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d; body=%s", rec.Code, http.StatusBadRequest, rec.Body.String())
	}
	if ops.createWindowWithOptionsCalled {
		t.Error("CreateWindowWithOptions must NOT be called for a typed window with an empty name")
	}
}

// An omitted "name" key on the rkType path is equally rejected (400).
func TestWindowCreateIframeOmittedNameRejected(t *testing.T) {
	ops := &mockTmuxOps{}
	router := newTestRouter(&mockSessionFetcher{}, ops)

	body := `{"rkType":"iframe","rkUrl":"http://localhost:8080/docs"}`
	req := httptest.NewRequest(http.MethodPost, "/api/sessions/dev/windows", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d; body=%s", rec.Code, http.StatusBadRequest, rec.Body.String())
	}
	if ops.createWindowWithOptionsCalled {
		t.Error("CreateWindowWithOptions must NOT be called for a typed window with an omitted name")
	}
}

func TestWindowCreateWithoutRkTypeUsesStandardCreate(t *testing.T) {
	ops := &mockTmuxOps{}
	router := newTestRouter(&mockSessionFetcher{}, ops)

	body := `{"name":"terminal","cwd":"~/code"}`
	req := httptest.NewRequest(http.MethodPost, "/api/sessions/dev/windows", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusCreated {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusCreated)
	}

	if ops.createWindowWithOptionsCalled {
		t.Error("CreateWindowWithOptions should NOT be called for terminal windows")
	}
	if !ops.createWindowCalled {
		t.Error("CreateWindow was not called")
	}
}

// TestWindowOptions_POST_wakesHub verifies the handleWindowOptions wake seam: a
// successful /options POST wakes the request's server so the poll loop runs a
// fresh pass promptly (the fix for the 5–10s @rk_win_color/@rk_win_url/@rk_win_lens latency),
// while a rejected (unknown-key) POST does not wake. Shares newWakeSeamServer /
// expectWake / expectNoWake with the session-color seam test in sessions_test.go.
func TestWindowOptions_POST_wakesHub(t *testing.T) {
	t.Run("successful set wakes", func(t *testing.T) {
		server, tracker := newWakeSeamServer(t, &mockTmuxOps{})
		before := tracker.count.Load()
		router := server.buildRouter()
		req := httptest.NewRequest(http.MethodPost, "/api/windows/@2/options?server=default", strings.NewReader(`{"options":{"@rk_win_color":"5"}}`))
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("POST status = %d, want 200; body=%s", rec.Code, rec.Body.String())
		}
		expectWake(t, tracker, before, "window options set")
	})

	t.Run("successful marker set wakes", func(t *testing.T) {
		server, tracker := newWakeSeamServer(t, &mockTmuxOps{})
		before := tracker.count.Load()
		router := server.buildRouter()
		req := httptest.NewRequest(http.MethodPost, "/api/windows/@2/options?server=default", strings.NewReader(`{"options":{"@rk_win_marker":"manual:2"}}`))
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("POST status = %d, want 200; body=%s", rec.Code, rec.Body.String())
		}
		expectWake(t, tracker, before, "window marker set")
	})

	t.Run("rejected key does not wake", func(t *testing.T) {
		server, tracker := newWakeSeamServer(t, &mockTmuxOps{})
		before := tracker.count.Load()
		router := server.buildRouter()
		req := httptest.NewRequest(http.MethodPost, "/api/windows/@2/options?server=default", strings.NewReader(`{"options":{"@bogus":"x"}}`))
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("POST status = %d, want 400; body=%s", rec.Code, rec.Body.String())
		}
		expectNoWake(t, tracker, before, "window options rejected")
	})
}

// --- @rk_win_note tests (260824-bb5n-tab-status-note) ---

// A bare-text note is stamped with the server-side "<unix-epoch>:" prefix
// before the tmux write — the server owns the clock, never the client.
func TestWindowOptionsNoteStampsEpoch(t *testing.T) {
	ops := &mockTmuxOps{}
	before := time.Now().Unix()
	rec := postOptions(t, ops, "@2", `{"options":{"@rk_win_note":"blocked on flaky e2e"}}`)
	after := time.Now().Unix()

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body=%s", rec.Code, http.StatusOK, rec.Body.String())
	}
	op, ok := findOp(ops.setWindowOptionsOps, "@rk_win_note")
	if !ok || op.Value == nil {
		t.Fatalf("expected a valued @rk_win_note op, got %+v", op)
	}
	prefix, text, found := strings.Cut(*op.Value, ":")
	if !found {
		t.Fatalf("op value %q missing epoch prefix", *op.Value)
	}
	if text != "blocked on flaky e2e" {
		t.Errorf("note text = %q, want %q", text, "blocked on flaky e2e")
	}
	epoch, err := strconv.ParseInt(prefix, 10, 64)
	if err != nil {
		t.Fatalf("epoch prefix %q not numeric: %v", prefix, err)
	}
	if epoch < before || epoch > after {
		t.Errorf("epoch %d outside handler window [%d, %d]", epoch, before, after)
	}
}

// Surrounding whitespace is trimmed before stamping.
func TestWindowOptionsNoteTrims(t *testing.T) {
	ops := &mockTmuxOps{}
	rec := postOptions(t, ops, "@2", `{"options":{"@rk_win_note":"  hi  "}}`)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body=%s", rec.Code, http.StatusOK, rec.Body.String())
	}
	op, ok := findOp(ops.setWindowOptionsOps, "@rk_win_note")
	if !ok || op.Value == nil {
		t.Fatalf("expected a valued @rk_win_note op, got %+v", op)
	}
	_, text, _ := strings.Cut(*op.Value, ":")
	if text != "hi" {
		t.Errorf("note text = %q, want %q (trimmed)", text, "hi")
	}
}

// Over-length and control-char notes 400 with zero tmux calls
// (validate-all-then-execute preserved).
func TestWindowOptionsNoteValidation(t *testing.T) {
	over := strings.Repeat("x", validate.NoteTextMaxLength+1)
	cases := map[string]string{
		"over-length": `{"options":{"@rk_win_note":"` + over + `"}}`,
		"tab char":    `{"options":{"@rk_win_note":"a\tb"}}`,
		"newline":     `{"options":{"@rk_win_note":"a\nb"}}`,
		"bell (C0)":   `{"options":{"@rk_win_note":"a\u0007b"}}`,
		"DEL":         `{"options":{"@rk_win_note":"a\u007fb"}}`,
	}
	for name, body := range cases {
		t.Run(name, func(t *testing.T) {
			ops := &mockTmuxOps{}
			rec := postOptions(t, ops, "@2", body)
			if rec.Code != http.StatusBadRequest {
				t.Errorf("status = %d, want %d; body=%s", rec.Code, http.StatusBadRequest, rec.Body.String())
			}
			if ops.setWindowOptionsCalled {
				t.Error("SetWindowOptions must NOT be called for an invalid note")
			}
		})
	}
}

// Empty string, whitespace-only, and JSON null all unset the note (the
// @rk_win_marker mapping) — no "" value and no bare "<epoch>:" stamp is ever
// written.
func TestWindowOptionsNoteUnset(t *testing.T) {
	for name, body := range map[string]string{
		"empty string":    `{"options":{"@rk_win_note":""}}`,
		"whitespace only": `{"options":{"@rk_win_note":"   "}}`,
		"json null":       `{"options":{"@rk_win_note":null}}`,
	} {
		t.Run(name, func(t *testing.T) {
			ops := &mockTmuxOps{}
			rec := postOptions(t, ops, "@2", body)
			if rec.Code != http.StatusOK {
				t.Fatalf("status = %d, want %d; body=%s", rec.Code, http.StatusOK, rec.Body.String())
			}
			op, ok := findOp(ops.setWindowOptionsOps, "@rk_win_note")
			if !ok {
				t.Fatal("expected @rk_win_note op")
			}
			if op.Value != nil {
				t.Errorf("@rk_win_note value = %q, want nil (unset)", *op.Value)
			}
		})
	}
}

// --- Indexed web-tab family tests (@rk_win_web_<n> / _active / _layout / _code_root) ---

// Out-of-range and malformed indexed keys are NOT allowlisted: the slot above
// MaxWebTabs, the slot-0 form, and the _root twin all 400 with zero tmux
// calls.
func TestWindowOptionsWebSlotOutOfRangeRejected(t *testing.T) {
	for _, key := range []string{fmt.Sprintf("@rk_win_web_%d", tmux.MaxWebTabs+1), "@rk_win_web_0", "@rk_win_web_1_root"} {
		ops := &mockTmuxOps{}
		rec := postOptions(t, ops, "@0", fmt.Sprintf(`{"options":{%q:"/proxy/1/"}}`, key))
		if rec.Code != http.StatusBadRequest {
			t.Errorf("key %s: status = %d, want %d", key, rec.Code, http.StatusBadRequest)
		}
		if ops.setWindowOptionsCalled {
			t.Errorf("key %s: SetWindowOptions must NOT be called", key)
		}
	}
}

// A site-relative address produced by the web-add path can be written back to
// the indexed slot verbatim (the address-bar resubmission path).
func TestWindowOptionsWebSlotAcceptsSiteRelativeURL(t *testing.T) {
	stubWebTabFamily(t, tmux.WebTabFamily{Tabs: []string{"/tutorial/ch1-orientation.html"}, Active: 1})
	ops := &mockTmuxOps{}
	rec := postOptions(t, ops, "@0", `{"options":{"@rk_win_web_1":"/tutorial/ch1-orientation.html"}}`)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body=%s", rec.Code, http.StatusOK, rec.Body.String())
	}
	op, ok := findOp(ops.setWindowOptionsOps, "@rk_win_web_1")
	if !ok || op.Value == nil || *op.Value != "/tutorial/ch1-orientation.html" {
		t.Errorf("@rk_win_web_1 op = %+v, want site-relative value", op)
	}
}

// Layout values run through the shared layoutspec grammar (the tree form or a
// legacy preset string): a malformed tree, an unknown shape, a wrong arity,
// and a repeated non-tty surface all 400 with zero tmux calls; a valid value
// (and the duplicate-tty exception) sets verbatim — never canonicalised;
// empty unsets.
func TestWindowOptionsLayoutValidation(t *testing.T) {
	invalid := []string{
		"grid:tty", "single:tty,web", "split-h:web,web", "row:tty,code,chat,web", "single:desktop",
		"h(h(tty,web),code)", "h(tty)", "h(tty, web)",
	}
	for _, v := range invalid {
		ops := &mockTmuxOps{}
		rec := postOptions(t, ops, "@0", fmt.Sprintf(`{"options":{"@rk_win_layout":%q}}`, v))
		if rec.Code != http.StatusBadRequest {
			t.Errorf("layout %q: status = %d, want %d", v, rec.Code, http.StatusBadRequest)
		}
		if ops.setWindowOptionsCalled {
			t.Errorf("layout %q: SetWindowOptions must NOT be called", v)
		}
	}
	for _, v := range []string{"single:web", "main-left:tty,code,web", "row:tty,tty,web", "h(tty,v(code,web))", "h(tty,tty)", "h(tty,web,code,gui)"} {
		ops := &mockTmuxOps{}
		rec := postOptions(t, ops, "@0", fmt.Sprintf(`{"options":{"@rk_win_layout":%q}}`, v))
		if rec.Code != http.StatusOK {
			t.Fatalf("layout %q: status = %d, want %d; body=%s", v, rec.Code, http.StatusOK, rec.Body.String())
		}
		op, ok := findOp(ops.setWindowOptionsOps, "@rk_win_layout")
		if !ok || op.Value == nil || *op.Value != v {
			t.Errorf("layout %q: op = %+v, want value %q", v, op, v)
		}
	}
	// Empty string unsets (revert to the bare-tty render).
	ops := &mockTmuxOps{}
	rec := postOptions(t, ops, "@0", `{"options":{"@rk_win_layout":""}}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("empty layout: status = %d, want %d", rec.Code, http.StatusOK)
	}
	op, ok := findOp(ops.setWindowOptionsOps, "@rk_win_layout")
	if !ok || op.Value != nil {
		t.Errorf("empty layout: op = %+v, want nil value (unset)", op)
	}
}

// A gap write (slot beyond len+1) is a 400 with zero tmux calls — the family
// is dense on every write path.
func TestWindowOptionsWebGapRejected(t *testing.T) {
	stubWebTabFamily(t, tmux.WebTabFamily{Tabs: []string{"/proxy/1/"}, Active: 1})
	ops := &mockTmuxOps{}
	rec := postOptions(t, ops, "@0", `{"options":{"@rk_win_web_3":"/proxy/3/"}}`)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusBadRequest)
	}
	if ops.setWindowOptionsCalled {
		t.Error("SetWindowOptions must NOT be called for a gap write")
	}
}

// The active pointer must address a live tab at write time; the batch's own
// append counts. Null is allowed only on an empty family.
func TestWindowOptionsWebActiveValidation(t *testing.T) {
	t.Run("out of range", func(t *testing.T) {
		stubWebTabFamily(t, tmux.WebTabFamily{Tabs: []string{"/proxy/1/", "/proxy/2/"}, Active: 1})
		ops := &mockTmuxOps{}
		rec := postOptions(t, ops, "@0", `{"options":{"@rk_win_web_active":"3"}}`)
		if rec.Code != http.StatusBadRequest {
			t.Errorf("status = %d, want %d", rec.Code, http.StatusBadRequest)
		}
		if ops.setWindowOptionsCalled {
			t.Error("SetWindowOptions must NOT be called for an out-of-range active pointer")
		}
	})
	t.Run("null with tabs", func(t *testing.T) {
		stubWebTabFamily(t, tmux.WebTabFamily{Tabs: []string{"/proxy/1/"}, Active: 1})
		ops := &mockTmuxOps{}
		rec := postOptions(t, ops, "@0", `{"options":{"@rk_win_web_active":null}}`)
		if rec.Code != http.StatusBadRequest {
			t.Errorf("status = %d, want %d", rec.Code, http.StatusBadRequest)
		}
	})
	t.Run("batch append counts", func(t *testing.T) {
		stubWebTabFamily(t, tmux.WebTabFamily{Tabs: []string{"/proxy/1/"}, Active: 1})
		ops := &mockTmuxOps{}
		rec := postOptions(t, ops, "@0", `{"options":{"@rk_win_web_2":"/proxy/2/","@rk_win_web_active":"2"}}`)
		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d, want %d; body=%s", rec.Code, http.StatusOK, rec.Body.String())
		}
		activeOp, ok := findOp(ops.setWindowOptionsOps, "@rk_win_web_active")
		if !ok || activeOp.Value == nil || *activeOp.Value != "2" {
			t.Errorf("@rk_win_web_active op = %+v, want value \"2\"", activeOp)
		}
	})
	t.Run("null on empty family", func(t *testing.T) {
		stubWebTabFamily(t, tmux.WebTabFamily{})
		ops := &mockTmuxOps{}
		rec := postOptions(t, ops, "@0", `{"options":{"@rk_win_web_active":null}}`)
		if rec.Code != http.StatusOK {
			t.Errorf("status = %d, want %d", rec.Code, http.StatusOK)
		}
		op, ok := findOp(ops.setWindowOptionsOps, "@rk_win_web_active")
		if !ok || op.Value != nil {
			t.Errorf("@rk_win_web_active op = %+v, want nil value (unset)", op)
		}
	})
}

// A null on a web slot routes through WebRemove (density holds); the slot must
// exist.
func TestWindowOptionsWebSlotNullRemoves(t *testing.T) {
	stubWebTabFamily(t, tmux.WebTabFamily{Tabs: []string{"/proxy/1/", "/proxy/2/"}, Active: 2})
	removed := stubWebRemove(t)
	ops := &mockTmuxOps{}
	rec := postOptions(t, ops, "@0", `{"options":{"@rk_win_web_1":null}}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body=%s", rec.Code, http.StatusOK, rec.Body.String())
	}
	if len(*removed) != 1 || (*removed)[0] != 1 {
		t.Errorf("WebRemove calls = %v, want [1]", *removed)
	}
}

// The retired @rk_win_url compat key replaces the ACTIVE slot's URL; null
// removes the active slot via WebRemove.
// retire-with: legacy-option-key-translation
func TestWindowOptionsLegacyURLTargetsActiveSlot(t *testing.T) {
	stubWebTabFamily(t, tmux.WebTabFamily{Tabs: []string{"/proxy/1/", "/proxy/2/"}, Active: 2})
	ops := &mockTmuxOps{}
	rec := postOptions(t, ops, "@0", `{"options":{"@rk_win_url":"/proxy/9/"}}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body=%s", rec.Code, http.StatusOK, rec.Body.String())
	}
	op, ok := findOp(ops.setWindowOptionsOps, "@rk_win_web_2")
	if !ok || op.Value == nil || *op.Value != "/proxy/9/" {
		t.Errorf("@rk_win_web_2 op = %+v, want value \"/proxy/9/\" (active slot)", op)
	}

	stubWebTabFamily(t, tmux.WebTabFamily{Tabs: []string{"/proxy/1/", "/proxy/2/"}, Active: 2})
	removed := stubWebRemove(t)
	ops = &mockTmuxOps{}
	rec = postOptions(t, ops, "@0", `{"options":{"@rk_win_url":null}}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("null: status = %d, want %d; body=%s", rec.Code, http.StatusOK, rec.Body.String())
	}
	if len(*removed) != 1 || (*removed)[0] != 2 {
		t.Errorf("WebRemove calls = %v, want [2] (the active slot)", *removed)
	}
}

// A batch that removes a web slot AND writes another slot or the active
// pointer is order-dependent (the removal renumbers after the set), so it is
// rejected before any tmux call; removals alone still pass.
func TestWindowOptionsWebRemoveMixedRejected(t *testing.T) {
	for _, body := range []string{
		`{"options":{"@rk_win_web_1":null,"@rk_win_web_2":"/proxy/9/"}}`,
		`{"options":{"@rk_win_web_1":null,"@rk_win_web_active":"2"}}`,
		`{"options":{"@rk_win_url":null,"@rk_win_web_1":"/proxy/9/"}}`,
	} {
		stubWebTabFamily(t, tmux.WebTabFamily{Tabs: []string{"/proxy/1/", "/proxy/2/", "/proxy/3/"}, Active: 3})
		removed := stubWebRemove(t)
		ops := &mockTmuxOps{}
		rec := postOptions(t, ops, "@0", body)
		if rec.Code != http.StatusBadRequest {
			t.Errorf("%s: status = %d, want %d; body=%s", body, rec.Code, http.StatusBadRequest, rec.Body.String())
		}
		if len(*removed) != 0 || len(ops.setWindowOptionsOps) != 0 {
			t.Errorf("%s: tmux calls issued (removed=%v, set=%v), want none", body, *removed, ops.setWindowOptionsOps)
		}
	}

	stubWebTabFamily(t, tmux.WebTabFamily{Tabs: []string{"/proxy/1/", "/proxy/2/", "/proxy/3/"}, Active: 3})
	removed := stubWebRemove(t)
	rec := postOptions(t, &mockTmuxOps{}, "@0", `{"options":{"@rk_win_web_1":null,"@rk_win_web_3":null,"@rk_win_color":"5"}}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("removals + color: status = %d, want %d; body=%s", rec.Code, http.StatusOK, rec.Body.String())
	}
	if len(*removed) != 2 || (*removed)[0] != 3 || (*removed)[1] != 1 {
		t.Errorf("WebRemove calls = %v, want [3 1] (highest-first)", *removed)
	}
}

// --- Kill-seam recording (the recently-closed ring) ---
//
// The recorder seams (newClosedRouter, stubCaptureWindow) live in
// closed_test.go, shared with the /api/windows/closed route tests.

// TestWindowKillRecordsClosedWindow: with a wired snapshot store, the window is
// captured and pushed BEFORE the kill; the response carries the pushed record
// (store-stamped id/closedAt plus the resolved agent session identity) and the
// ring holds it.
func TestWindowKillRecordsClosedWindow(t *testing.T) {
	store := snapshot.NewStore(t.TempDir())
	stubCaptureWindow(t, snapshot.Window{
		Index: 2, ID: "@5", Name: "agent", Color: "4",
		Panes: []snapshot.Pane{{ID: "%1", Index: 0, Cwd: "/proj", Command: "claude", Active: true}},
	}, "dev", nil)
	sf := &mockSessionFetcher{result: forkSessions("dev", "@5", "agent", "claude", testForkRef, "/proj")}
	ops := &mockTmuxOps{}
	router := newClosedRouter(sf, ops, nil, store)

	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/windows/%405/kill?server=work", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	if !ops.killWindowCalled || ops.killWindowID != "@5" {
		t.Fatalf("kill = called %v on %q, want @5", ops.killWindowCalled, ops.killWindowID)
	}

	var body struct {
		Ok     bool                   `json:"ok"`
		Closed *snapshot.ClosedWindow `json:"closed"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if !body.Ok || body.Closed == nil {
		t.Fatalf("body = %s, want ok + closed", rec.Body.String())
	}
	got := body.Closed
	if got.ID == "" || got.ClosedAt.IsZero() {
		t.Errorf("record missing store-stamped identity: %+v", got)
	}
	if got.Server != "work" || got.Session != "dev" {
		t.Errorf("record server/session = %q/%q, want work/dev", got.Server, got.Session)
	}
	if got.Window.Name != "agent" || got.Window.Color != "4" || len(got.Window.Panes) != 1 {
		t.Errorf("record window = %+v, want the captured window", got.Window)
	}
	if got.AgentProvider != "claude" || got.AgentRef != testForkRef {
		t.Errorf("record agent identity = %q/%q, want claude/%s", got.AgentProvider, got.AgentRef, testForkRef)
	}

	// The same record is on the server's ring.
	list, err := store.ListClosed("work")
	if err != nil || len(list) != 1 {
		t.Fatalf("ring = %+v, %v — want exactly the pushed record", list, err)
	}
	if list[0].ID != got.ID || list[0].AgentRef != testForkRef {
		t.Errorf("ring record = %+v, want the response's record", list[0])
	}
}

// TestWindowKillCaptureFailureStillKills: a capture read failure (window already
// gone, tmux fault) must NEVER block or fail the kill — 200 {"ok": true} with
// no "closed" key, nothing on the ring.
func TestWindowKillCaptureFailureStillKills(t *testing.T) {
	store := snapshot.NewStore(t.TempDir())
	stubCaptureWindow(t, snapshot.Window{}, "", errors.New("capture: window gone"))
	ops := &mockTmuxOps{}
	router := newClosedRouter(&mockSessionFetcher{}, ops, nil, store)

	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/windows/%405/kill?server=work", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	if !ops.killWindowCalled {
		t.Error("KillWindow was not called after a capture failure")
	}
	if body := strings.TrimSpace(rec.Body.String()); body != `{"ok":true}` {
		t.Errorf("body = %q, want exactly {\"ok\":true} (no closed key)", body)
	}
	if list, _ := store.ListClosed("work"); len(list) != 0 {
		t.Errorf("ring gained a record despite capture failure: %+v", list)
	}
}

// TestWindowKillNilStoreStillKills: with no snapshot store wired the kill is
// exactly the pre-recording behavior — no capture attempt, 200 {"ok": true}.
func TestWindowKillNilStoreStillKills(t *testing.T) {
	stubCaptureWindow(t, snapshot.Window{}, "", nil) // must not be reached
	captureCalled := false
	prev := captureWindowFn
	captureWindowFn = func(context.Context, string, string) (snapshot.Window, string, error) {
		captureCalled = true
		return snapshot.Window{}, "", nil
	}
	t.Cleanup(func() { captureWindowFn = prev })

	ops := &mockTmuxOps{}
	router := newTestRouter(&mockSessionFetcher{}, ops)

	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/windows/%405/kill?server=work", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	if captureCalled {
		t.Error("capture ran with a nil store")
	}
	if !ops.killWindowCalled {
		t.Error("KillWindow was not called")
	}
	if body := strings.TrimSpace(rec.Body.String()); body != `{"ok":true}` {
		t.Errorf("body = %q, want exactly {\"ok\":true}", body)
	}
}
