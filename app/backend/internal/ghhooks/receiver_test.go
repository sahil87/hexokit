package ghhooks

import (
	"bytes"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"rk/internal/operator"
)

type wakeLog struct {
	mu    sync.Mutex
	calls [][2]string
}

func (w *wakeLog) wake(server, reason string) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.calls = append(w.calls, [2]string{server, reason})
	return nil
}

func newTestReceiver(t *testing.T, servers []string, ledgers map[string]*operator.State) (*Receiver, *wakeLog) {
	t.Helper()
	log := &wakeLog{}
	return &Receiver{Source: source(servers, ledgers, nil, map[string]int{}), Wake: log.wake}, log
}

func post(t *testing.T, r *Receiver, method, path, event, body string) *http.Response {
	t.Helper()
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	if event != "" {
		req.Header.Set(EventHeader, event)
	}
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	r.Wait()
	return rec.Result()
}

const checkSuiteBody = `{"repository":{"full_name":"o/r"},"check_suite":{"head_branch":"feat-x","pull_requests":[{"number":12}]}}`

func TestReceiverWakesEachMatchingServerOnce(t *testing.T) {
	ledgers := map[string]*operator.State{
		// Two items on the same event: one marker, not two.
		"work": state(nil, prItem(t, "pr-12", "o/r", 12, ""), prItem(t, "pr-12b", "o/r", 12, "feat-x")),
		"also": state(nil, prItem(t, "pr-12c", "o/r", 12, "")),
		"play": state(nil),
	}
	r, log := newTestReceiver(t, []string{"work", "also", "play"}, ledgers)

	resp := post(t, r, http.MethodPost, HookPath, "check_suite", checkSuiteBody)
	if resp.StatusCode/100 != 2 {
		t.Fatalf("status = %d, want 2xx", resp.StatusCode)
	}
	want := [][2]string{{"work", "pr:o/r#12:check_suite"}, {"also", "pr:o/r#12:check_suite"}}
	if len(log.calls) != len(want) || log.calls[0] != want[0] || log.calls[1] != want[1] {
		t.Errorf("wakes = %v, want %v", log.calls, want)
	}
}

func TestReceiverIgnoresUntrackedAndUnknownDeliveries(t *testing.T) {
	ledgers := map[string]*operator.State{"work": state(nil, prItem(t, "pr-12", "o/r", 12, ""))}
	cases := []struct{ name, event, body string }{
		{"untracked PR", "pull_request", `{"repository":{"full_name":"o/r"},"pull_request":{"number":99,"head":{"ref":"zzz"}}}`},
		{"unsubscribed event", "issues", `{"repository":{"full_name":"o/r"}}`},
		{"ping", "ping", `{"zen":"x"}`},
		{"malformed JSON", "pull_request", `{oops`},
		{"no PR identity", "check_suite", `{"repository":{"full_name":"o/r"},"check_suite":{}}`},
		{"no event header", "", checkSuiteBody},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r, log := newTestReceiver(t, []string{"work"}, ledgers)
			resp := post(t, r, http.MethodPost, HookPath, tc.event, tc.body)
			if resp.StatusCode/100 != 2 {
				t.Errorf("status = %d, want 2xx so the forwarder never retries", resp.StatusCode)
			}
			if len(log.calls) != 0 {
				t.Errorf("wakes = %v, want none", log.calls)
			}
		})
	}
}

func TestReceiverSkipsDeadServers(t *testing.T) {
	// "dead" tracks the PR but is not in the live list.
	ledgers := map[string]*operator.State{
		"live": state(nil, prItem(t, "pr-12", "o/r", 12, "")),
		"dead": state(nil, prItem(t, "pr-12", "o/r", 12, "")),
	}
	r, log := newTestReceiver(t, []string{"live"}, ledgers)
	post(t, r, http.MethodPost, HookPath, "check_suite", checkSuiteBody)
	if len(log.calls) != 1 || log.calls[0][0] != "live" {
		t.Errorf("wakes = %v, want only the live server", log.calls)
	}
}

func TestReceiverRoutesAndLimits(t *testing.T) {
	r, log := newTestReceiver(t, nil, nil)
	if got := post(t, r, http.MethodGet, HookPath, "", "").StatusCode; got != http.StatusMethodNotAllowed {
		t.Errorf("GET status = %d, want 405", got)
	}
	if got := post(t, r, http.MethodPost, "/other", "check_suite", checkSuiteBody).StatusCode; got != http.StatusNotFound {
		t.Errorf("other path status = %d, want 404", got)
	}
	big := `{"repository":{"full_name":"o/r"},"pad":"` + strings.Repeat("x", MaxBodyBytes) + `"}`
	if got := post(t, r, http.MethodPost, HookPath, "check_suite", big).StatusCode; got != http.StatusRequestEntityTooLarge {
		t.Errorf("over-cap status = %d, want 413", got)
	}
	if len(log.calls) != 0 {
		t.Errorf("wakes = %v, want none", log.calls)
	}
}

func TestReceiverWakeFailureIsNotAnHTTPError(t *testing.T) {
	ledgers := map[string]*operator.State{"work": state(nil, prItem(t, "pr-12", "o/r", 12, ""))}
	r, _ := newTestReceiver(t, []string{"work"}, ledgers)
	r.Wake = func(string, string) error { return io.ErrClosedPipe }
	if got := post(t, r, http.MethodPost, HookPath, "check_suite", checkSuiteBody).StatusCode; got/100 != 2 {
		t.Errorf("status = %d, want 2xx even when the marker write fails", got)
	}
}

func TestReceiverLogsNoPayloadContent(t *testing.T) {
	var buf bytes.Buffer
	ledgers := map[string]*operator.State{"work": state(nil, prItem(t, "pr-12", "o/r", 12, ""))}
	r, _ := newTestReceiver(t, []string{"work"}, ledgers)
	r.Logger = newBufLogger(&buf)
	body := `{"repository":{"full_name":"o/r"},"sender":{"login":"SECRET-LOGIN"},"check_suite":{"head_branch":"feat","pull_requests":[{"number":12}],"head_commit":{"message":"SECRET-COMMIT-MESSAGE"}}}`
	post(t, r, http.MethodPost, HookPath, "check_suite", body)
	out := buf.String()
	if strings.Contains(out, "SECRET") {
		t.Errorf("payload content reached the log: %s", out)
	}
	if !strings.Contains(out, "check_suite") || !strings.Contains(out, "o/r#12") {
		t.Errorf("log should carry the event name and nwo#n, got: %s", out)
	}
}

func newBufLogger(w io.Writer) *slog.Logger {
	return slog.New(slog.NewTextHandler(w, nil))
}
