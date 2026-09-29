package api

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"rk/internal/gitinfo"
	"rk/internal/sessions"
	"rk/internal/validate"
)

// operatorStartProcessTimeout bounds the spawned `rk operator` process itself.
// It must exceed the launched agent's own boot + kickoff bound (the
// cron.DefaultRespawnTimeout precedent). DETACHED from the request: the
// response goes out on the JSON receipt while the process finishes its kickoff.
// operatorStartReceiptTimeout bounds the wait for the receipt line only. Vars
// (not consts) so tests can shrink the receipt bound — the cmd/rk
// operatorDeliverDeadline precedent.
var (
	operatorStartProcessTimeout = 90 * time.Second
	operatorStartReceiptTimeout = 30 * time.Second
)

// errOperatorStartTimeout marks the no-receipt-in-bound outcome so the handler
// maps it to 504 while every other exec failure is a 502.
var errOperatorStartTimeout = errors.New("operator start timed out")

// operatorStartReceipt is the parsed `rk operator --json` success document (the
// envelope's result — see cmd/rk's operatorReceipt). Dir/DirRung are additive
// cmd/rk fields: omitted by older binaries, tolerated by this parse.
type operatorStartReceipt struct {
	Window  string `json:"window"`
	Server  string `json:"server"`
	Created bool   `json:"created"`
	Dir     string `json:"dir,omitempty"`
	DirRung string `json:"dir_rung,omitempty"`
}

// operatorStartExitFn fires once the receipted `rk operator` process exits —
// the receipt already returned to the HTTP caller, so this carries the
// post-receipt facts: the receipt, the full captured stderr (the kickoff:
// undelivered note lives there), and the process's exit error.
type operatorStartExitFn func(receipt operatorStartReceipt, stderr string, exitErr error)

// operatorStartRunFn is the exec seam behind POST /api/operator/start: run argv
// (the daemon's own binary + `operator -L <server> [--dir <dir>] --json`),
// returning the parsed receipt, the captured stderr, and the failure
// (errOperatorStartTimeout on a receipt timeout). onExit fires from the
// post-receipt Wait goroutine. Package var seam (the resolveSelfPathFn
// precedent) so handler tests stub the exec; the default owns the process
// lifetime.
var operatorStartRunFn = runOperatorStartExec

// operatorStartMainRootFn collapses the viewed window's pane cwd to its
// main-worktree root ("" when not inside a repository — the cwd is then used
// verbatim). Package var seam (the operatorStartRunFn precedent) so handler
// tests stub the git subprocess.
var operatorStartMainRootFn = gitinfo.MainWorktreeRoot

// operatorStartBody is the optional request body: the id of the window the
// user is viewing when they start the operator. The body carries ONLY the
// window identity — the daemon derives the directory from tmux itself
// (Constitution II), never from a client-supplied path.
type operatorStartBody struct {
	Window string `json:"window"`
}

// parseOperatorStartBody reads the optional {"window": "@N"} body. ok=false
// means the response has already been written (400): malformed JSON or a
// malformed window id. An empty body decodes as the zero value ("no viewed
// window") — the pre-change shape.
func parseOperatorStartBody(w http.ResponseWriter, r *http.Request) (operatorStartBody, bool) {
	var body operatorStartBody
	dec := json.NewDecoder(r.Body)
	if err := dec.Decode(&body); err != nil {
		if errors.Is(err, io.EOF) {
			return body, true
		}
		writeError(w, http.StatusBadRequest, "invalid JSON body: "+err.Error())
		return body, false
	}
	// One value is the whole contract: trailing garbage or a second
	// concatenated value is malformed JSON (400), not a tolerated suffix.
	var extra any
	if err := dec.Decode(&extra); !errors.Is(err, io.EOF) {
		writeError(w, http.StatusBadRequest, "invalid JSON body: unexpected data after the JSON value")
		return body, false
	}
	if body.Window != "" {
		if errMsg := validate.ValidateWindowID(body.Window, "Window ID"); errMsg != "" {
			writeError(w, http.StatusBadRequest, errMsg)
			return body, false
		}
	}
	return body, true
}

// validOperatorStartDir is the handler-side equivalent of the CLI's
// validateOperatorDir gate: the derived --dir value must be an absolute path
// to an existing directory, or the exec would fail with the CLI's usage
// error.
func validOperatorStartDir(dir string) bool {
	if !filepath.IsAbs(dir) {
		return false
	}
	st, err := os.Stat(dir)
	return err == nil && st.IsDir()
}

// operatorStartDir derives the --dir value for the launch from the viewed
// window's active-pane cwd (WindowInfo.WorktreePath) in the already-fetched
// sessions slice — no second fetch. The cwd is collapsed to its main-worktree
// root (a linked worktree maps to the main checkout) or used verbatim when it
// is not inside a git repository. ok=false — the window unknown to the
// server, an empty cwd, or a derived directory failing the pre-check —
// degrades the launch to the no-window argv rather than failing the start: a
// raced close must not break Start, and the pre-check keeps a doomed exec
// from surfacing the CLI's usage error as a 502.
func operatorStartDir(ctx context.Context, sess []sessions.ProjectSession, windowID string) (string, bool) {
	win := findOperatorSubject(sess, windowID)
	if win == nil || win.WorktreePath == "" {
		return "", false
	}
	dir := win.WorktreePath
	if root := operatorStartMainRootFn(ctx, dir); root != "" {
		dir = root
	}
	if !validOperatorStartDir(dir) {
		return "", false
	}
	return dir, true
}

// handleOperatorStart serves POST /api/operator/start?server= — start the
// server's operator window by exec'ing this daemon's own binary as
// `rk operator -L <server> --json`, responding once the receipt line parses.
// POST per Constitution IX. The optional body {"window": "@N"} names the
// window the user is viewing: its active-pane cwd (collapsed to the main
// checkout) rides the argv as --dir, so the operator starts where the user
// is. No window in the body (or one that cannot be resolved) keeps the bare
// argv — the CLI's recorded-directory → home rule decides.
//
// POST /api/operator/start → 202 {"windowId","server"} | 400 {"error"} | 409 {code:operator_exists,windowId} | 500/502/504 {"error"}
func (s *Server) handleOperatorStart(w http.ResponseWriter, r *http.Request) {
	server := serverFromRequest(r)

	sess, err := s.sessions.FetchSessions(r.Context(), server)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if op := findOperatorWindow(sess); op != nil {
		writeOperatorExists(w, op.WindowID)
		return
	}

	body, ok := parseOperatorStartBody(w, r)
	if !ok {
		return
	}

	selfPath, err := resolveSelfPathFn()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "could not determine executable path")
		return
	}

	argv := []string{selfPath, "operator", "-L", server, "--json"}
	if body.Window != "" {
		// The derivation outlives the request like the exec below it
		// (runOperatorStartExec detaches): a client disconnect must not
		// silently degrade the main-root collapse to the verbatim pane cwd.
		if dir, ok := operatorStartDir(context.WithoutCancel(r.Context()), sess, body.Window); ok {
			argv = []string{selfPath, "operator", "-L", server, "--dir", dir, "--json"}
		}
	}
	receipt, stderr, err := operatorStartRunFn(r.Context(), argv, s.operatorKickoffExit(server))
	if err != nil {
		if errors.Is(err, errOperatorStartTimeout) {
			writeError(w, http.StatusGatewayTimeout, errOperatorStartTimeout.Error())
			return
		}
		msg := firstNonEmptyLine(stderr)
		if msg == "" {
			msg = err.Error()
		}
		writeError(w, http.StatusBadGateway, msg)
		return
	}
	if !receipt.Created {
		// The singleton probe beat the pre-check — same 409 contract.
		writeOperatorExists(w, receipt.Window)
		return
	}

	s.initSSEHub()
	s.sseHub.wake(server)
	writeJSON(w, http.StatusAccepted, map[string]string{"windowId": receipt.Window, "server": receipt.Server})
}

// writeOperatorExists is the shared 409 body for both operator-present
// detections: writeErrorCode's shape plus the incumbent window id.
func writeOperatorExists(w http.ResponseWriter, windowID string) {
	writeJSON(w, http.StatusConflict, map[string]string{
		"error":    "operator already present",
		"code":     "operator_exists",
		"windowId": windowID,
	})
}

// runOperatorStartExec is the production operatorStartRunFn: an argv-slice
// exec.CommandContext (never a shell string, Constitution I) under a detached
// 90s context, accumulating stdout until the rk JSON receipt — one indented
// multi-line document (outputSink.writeEnvelope uses json.MarshalIndent) —
// parses as a whole (30s bound), then letting the process finish its kickoff
// in a goroutine that fires onExit after the exit lands.
func runOperatorStartExec(_ context.Context, argv []string, onExit operatorStartExitFn) (operatorStartReceipt, string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), operatorStartProcessTimeout)
	cmd := exec.CommandContext(ctx, argv[0], argv[1:]...)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		cancel()
		return operatorStartReceipt{}, "", err
	}
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Start(); err != nil {
		cancel()
		return operatorStartReceipt{}, "", err
	}

	type scanResult struct {
		receipt operatorStartReceipt
		ok      bool
	}
	scanned := make(chan scanResult, 1)
	go func() {
		scanner := bufio.NewScanner(stdout)
		var pending bytes.Buffer
		for scanner.Scan() {
			line := scanner.Bytes()
			if pending.Len() == 0 && !bytes.HasPrefix(bytes.TrimSpace(line), []byte("{")) {
				continue // chatter on the data channel — a document starts with {
			}
			pending.Write(line)
			pending.WriteByte('\n')
			receipt, complete, ok := parseOperatorStartEnvelope(pending.Bytes())
			if !complete {
				continue // still mid-document
			}
			pending.Reset()
			if !ok {
				continue // a complete non-success document (the {"ok":false} failure)
			}
			scanned <- scanResult{receipt, true}
			// Keep draining past the receipt so a chatty process never
			// blocks on a full stdout pipe.
			_, _ = io.Copy(io.Discard, stdout)
			return
		}
		scanned <- scanResult{}
	}()

	timer := time.NewTimer(operatorStartReceiptTimeout)
	defer timer.Stop()
	select {
	case res := <-scanned:
		if res.ok {
			go func() {
				defer cancel()
				err := cmd.Wait()
				if err != nil {
					slog.Warn("operator start exited non-zero after its receipt", "err", err)
				}
				if onExit != nil {
					onExit(res.receipt, stderr.String(), err)
				}
			}()
			return res.receipt, "", nil
		}
		// stdout closed with no receipt — the process is exiting or gone.
		defer cancel()
		if err := cmd.Wait(); err != nil {
			return operatorStartReceipt{}, stderr.String(), err
		}
		return operatorStartReceipt{}, stderr.String(), errors.New("operator exited without a receipt")
	case <-timer.C:
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
		cancel()
		return operatorStartReceipt{}, stderr.String(), errOperatorStartTimeout
	}
}

// parseOperatorStartEnvelope decodes one accumulated stdout chunk as a whole
// rk --json envelope document. complete=false means the bytes are a JSON
// prefix (keep accumulating); complete=true with ok=false means a full
// document that is not the success receipt (chatter-shaped bytes or the
// failure envelope) — the caller drops the chunk and keeps scanning.
func parseOperatorStartEnvelope(data []byte) (receipt operatorStartReceipt, complete, ok bool) {
	var env struct {
		OK     bool                  `json:"ok"`
		Result *operatorStartReceipt `json:"result"`
	}
	if err := json.Unmarshal(data, &env); err != nil {
		var syn *json.SyntaxError
		if errors.As(err, &syn) && syn.Error() == "unexpected end of JSON input" {
			return operatorStartReceipt{}, false, false
		}
		return operatorStartReceipt{}, true, false
	}
	if !env.OK || env.Result == nil {
		return operatorStartReceipt{}, true, false
	}
	return *env.Result, true, true
}

// kickoffNotePrefix heads the single stderr line rk prints when its kickoff
// delivery fails (exit code stays 0): `kickoff: undelivered reason=<r>
// prompt=<quoted> dir=<quoted>` — prompt and dir are Go-quoted strings
// (strconv.Quote), so a value containing spaces or " dir=" stays one field.
// The internal/cron kickoffUndeliveredMarker precedent.
const kickoffNotePrefix = "kickoff: undelivered reason="

// parseKickoffNote extracts the reason, the rendered kickoff prompt, and the
// window directory from the stderr kickoff note. reason is a bare token;
// prompt and dir are consumed as Go-quoted literals (strconv.QuotedPrefix),
// which is what makes the framing unambiguous. Anything after the dir field
// is tolerated. ok=false when no well-formed note is present (a missing or
// malformed field, or an empty reason/dir).
func parseKickoffNote(stderr string) (reason, prompt, dir string, ok bool) {
	for line := range strings.Lines(stderr) {
		rest, found := strings.CutPrefix(strings.TrimSpace(line), kickoffNotePrefix)
		if !found {
			continue
		}
		reason, rest, _ := strings.Cut(rest, " ")
		if reason == "" {
			continue
		}
		prompt, rest, found = cutQuotedField(rest, "prompt=")
		if !found {
			continue
		}
		dir, _, found = cutQuotedField(rest, " dir=")
		if !found || dir == "" {
			continue
		}
		return reason, prompt, dir, true
	}
	return "", "", "", false
}

// cutQuotedField consumes `<label><go-quoted string>` at the head of s,
// returning the unquoted value and the remainder after the closing quote.
// ok=false when the label is absent or the literal does not parse.
func cutQuotedField(s, label string) (value, rest string, ok bool) {
	s, found := strings.CutPrefix(s, label)
	if !found {
		return "", "", false
	}
	quoted, err := strconv.QuotedPrefix(s)
	if err != nil {
		return "", "", false
	}
	value, err = strconv.Unquote(quoted)
	if err != nil {
		return "", "", false
	}
	return value, s[len(quoted):], true
}

// operatorKickoffExit builds the onExit callback for one operator start: when
// the process's stderr carries the kickoff note, warn and notify so a
// connected client can paste the note's provider-rendered kickoff prompt
// (`/fab-operator`, or `$fab-operator` for a codex operator) into the operator
// terminal by hand. A clean exit with no note logs nothing and broadcasts
// nothing.
func (s *Server) operatorKickoffExit(server string) operatorStartExitFn {
	return func(receipt operatorStartReceipt, stderr string, _ error) {
		reason, prompt, dir, ok := parseKickoffNote(stderr)
		if !ok {
			return
		}
		slog.Warn("operator kickoff undelivered",
			"server", server, "window", receipt.Window, "reason", reason, "dir", dir, "prompt", prompt)
		s.initSSEHub()
		// The prompt is the launcher's provider-rendered kickoff (a codex
		// operator gets `$fab-operator`), so the instruction names the exact
		// text to paste rather than the canonical slash form.
		s.sseHub.broadcastNotifyTagged(
			"Operator kickoff not delivered",
			fmt.Sprintf("Operator on %s started in %s but %s was not delivered (%s) — paste it into the operator terminal", server, dir, prompt, reason),
			// The frontend has no dedicated /$server/operator path — the operator
			// surface IS the operator window's own terminal route, the same
			// deep-link shape the waiting-window push uses.
			waitingPushURL(server, receipt.Window),
			"operator-kickoff",
		)
	}
}

func firstNonEmptyLine(s string) string {
	for line := range strings.Lines(s) {
		if trimmed := strings.TrimSpace(line); trimmed != "" {
			return trimmed
		}
	}
	return ""
}
