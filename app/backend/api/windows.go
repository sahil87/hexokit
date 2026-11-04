package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"rk/internal/layoutspec"
	"rk/internal/snapshot"
	"rk/internal/tmux"
	"rk/internal/validate"
)

func (s *Server) handleWindowCreate(w http.ResponseWriter, r *http.Request) {
	session := chi.URLParam(r, "session")
	if errMsg := validate.ValidateName(session, "Session name"); errMsg != "" {
		writeError(w, http.StatusBadRequest, errMsg)
		return
	}

	var body struct {
		Name   string `json:"name"`
		CWD    string `json:"cwd"`
		RkType string `json:"rkType"`
		RkUrl  string `json:"rkUrl"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "Invalid JSON body")
		return
	}

	// Window name is optional on CREATE: an omitted/empty name means "let tmux
	// auto-name the window to its folder basename" (via automatic-rename-format
	// in the embedded configs). Only a non-empty name is validated. The rename
	// path (handleWindowRename) still requires a non-empty, validated name.
	if body.Name != "" {
		// Tightened new-name rule (no spaces) — this names a to-be-created window.
		if errMsg := validate.ValidateNewName(body.Name, "Window name"); errMsg != "" {
			writeError(w, http.StatusBadRequest, errMsg)
			return
		}
	}

	server := serverFromRequest(r)

	var resolvedCwd string
	if body.CWD != "" {
		if errMsg := validate.ValidatePath(body.CWD, "Working directory"); errMsg != "" {
			writeError(w, http.StatusBadRequest, errMsg)
			return
		}
		expanded, expandErr := validate.ExpandTilde(body.CWD)
		if expandErr != "" {
			writeError(w, http.StatusBadRequest, expandErr)
			return
		}
		resolvedCwd = expanded
	} else {
		// Default to the cwd of the first window in the session.
		// Use a dedicated timeout context (not the request context) because the
		// result feeds into the subsequent CreateWindow mutation. If we used
		// r.Context() and the client disconnected, ListWindows would return
		// (nil, nil) and the mutation would create the window with an empty cwd.
		cwdCtx, cwdCancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cwdCancel()
		if windows, err := s.tmux.ListWindows(cwdCtx, session, server); err == nil && len(windows) > 0 {
			resolvedCwd = windows[0].WorktreePath
		}
	}

	// When rkType is present, create the window and set its web-tab family
	// options atomically in one chained tmux command — prevents the SSE poll
	// from seeing the window before its metadata is set. The option set reuses
	// the same allowlisted keys and the same WindowOptionOp chaining primitive
	// as the /options endpoint (no separate inline option-map construction path);
	// window creation and option-set stay in a single invocation so they are
	// atomic at creation. The body keeps the retired rkType/rkUrl field NAMES
	// this release (the client's createWindow arm is renamed by the frontend
	// layout change); "iframe" is the only accepted value — it maps onto
	// layout=web + the first web slot + the active pointer.
	if body.RkType != "" {
		if body.RkType != "iframe" {
			writeError(w, http.StatusBadRequest, "Unsupported rkType: "+body.RkType)
			return
		}
		// The rkType path pins an explicit name (CreateWindowWithOptions runs
		// new-window -n <name> with automatic-rename disabled), so an empty name
		// would create a window stuck on an empty name. Unlike the plain create
		// path (which omits -n and lets tmux auto-name), a name is required here.
		// The shipped UI always supplies one; this pins the API contract.
		if body.Name == "" {
			writeError(w, http.StatusBadRequest, "Window name is required when rkType is set")
			return
		}
		if strings.TrimSpace(body.RkUrl) == "" {
			writeError(w, http.StatusBadRequest, "rkUrl is required when rkType is set")
			return
		}
		if errMsg := validate.ValidateWebTabURL(body.RkUrl); errMsg != "" {
			writeError(w, http.StatusBadRequest, errMsg)
			return
		}
		layout := "web"
		rkURL := body.RkUrl
		active := "1"
		ops := []tmux.WindowOptionOp{
			{Key: tmux.LayoutOption, Value: &layout},
			{Key: tmux.WebTabOption(1), Value: &rkURL},
			{Key: tmux.WebActiveOption, Value: &active},
		}
		if err := s.tmux.CreateWindowWithOptions(session, body.Name, resolvedCwd, server, ops); err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		writeJSON(w, http.StatusCreated, map[string]bool{"ok": true})
		return
	}

	if err := s.tmux.CreateWindow(session, body.Name, resolvedCwd, server); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	writeJSON(w, http.StatusCreated, map[string]bool{"ok": true})
}

// decodeWindowID percent-decodes (url.PathUnescape) the {windowId} path param
// and validates it via validate.ValidateWindowID, returning (id, true) on
// success and ("", false) on either failure. The REST handlers reach it via
// parseWindowID; the terminals mux (api/terminals_ws.go) validates its `open`
// op's already-JSON-decoded windowId through the SAME validate.ValidateWindowID
// call, so the two entry points share one validator and cannot drift (the drift
// that caused bug #205). The mux path needs no percent-decode — its windowId
// arrives decoded in a JSON control frame, not a URL path segment.
//
// chi v5's URLParam returns the path param as it appears in the matched route:
// for '@' encoded as '%40', URLParam returns the encoded form, so an explicit
// PathUnescape is required. (RawPath is set by net/http only when the decoded
// path differs from the raw path; this decode does not depend on whether the
// server set RawPath.)
func decodeWindowID(r *http.Request) (string, bool) {
	id, err := url.PathUnescape(chi.URLParam(r, "windowId"))
	if err != nil {
		return "", false
	}
	if validate.ValidateWindowID(id, "Window ID") != "" {
		return "", false
	}
	return id, true
}

// parseWindowID extracts and validates the tmux window ID from the URL.
// Returns (id, true) on success, ("", false) when the {windowId} path parameter
// is missing or malformed (handlers respond 400 in that case). It delegates the
// decode+validate to the shared decodeWindowID helper.
func parseWindowID(r *http.Request) (string, bool) {
	return decodeWindowID(r)
}

func (s *Server) handleWindowKill(w http.ResponseWriter, r *http.Request) {
	windowID, ok := parseWindowID(r)
	if !ok {
		writeError(w, http.StatusBadRequest, "Invalid window ID")
		return
	}
	server := serverFromRequest(r)

	// Record the window onto the recently-closed ring BEFORE the kill — the
	// @rk_win_* option set dies with the window and is never derivable after.
	// Recording is strictly best-effort: any failure is slog.Debug inside
	// recordClosedWindow and the kill proceeds with no record (response then
	// omits "closed").
	var closed *snapshot.ClosedWindow
	if s.snapshotStore != nil {
		closed = s.recordClosedWindow(server, windowID)
	}

	if err := s.tmux.KillWindow(windowID, server); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	if closed != nil {
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "closed": closed})
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) handleWindowRename(w http.ResponseWriter, r *http.Request) {
	windowID, ok := parseWindowID(r)
	if !ok {
		writeError(w, http.StatusBadRequest, "Invalid window ID")
		return
	}

	var body struct {
		Name string `json:"name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "Invalid JSON body")
		return
	}

	// Tightened new-name rule (no spaces) — this is the renamed-TO name.
	if errMsg := validate.ValidateNewName(body.Name, "Window name"); errMsg != "" {
		writeError(w, http.StatusBadRequest, errMsg)
		return
	}

	if err := s.tmux.RenameWindow(windowID, body.Name, serverFromRequest(r)); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// handleWindowSelect focuses a window by its stable ID. It resolves the owning
// (non-ephemeral) session server-side and issues a session-scoped select
// (select-window -t <session>:@N) rather than a bare select. A bare target is
// ambiguous inside a tmux session group — group members share window membership
// but keep independent active-window state — so the scoped form is required for
// correctness. The session is disambiguation context derived server-side; the
// client never supplies it.
func (s *Server) handleWindowSelect(w http.ResponseWriter, r *http.Request) {
	windowID, ok := parseWindowID(r)
	if !ok {
		writeError(w, http.StatusBadRequest, "Invalid window ID")
		return
	}

	server := serverFromRequest(r)
	// Dedicated timeout context (not r.Context()) — the resolved session feeds
	// the subsequent select mutation.
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	session, err := s.tmux.ResolveWindowSession(ctx, server, windowID)
	if err != nil {
		// Stale @N — surface the resolve failure; never fall back to a bare
		// select against the stale id.
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	if err := s.tmux.SelectWindowInSession(session, windowID, server); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	// Report the post-select active window so the client can confirm the switch
	// without waiting for the state socket. The read is best-effort: the select
	// itself succeeded, so a failed read falls back to the requested id rather
	// than failing the request.
	activeWindow, readErr := s.tmux.ActiveWindowID(ctx, server, session)
	if readErr != nil {
		activeWindow = windowID
	}

	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "activeWindow": activeWindow})
}

func (s *Server) handleWindowSplit(w http.ResponseWriter, r *http.Request) {
	windowID, ok := parseWindowID(r)
	if !ok {
		writeError(w, http.StatusBadRequest, "Invalid window ID")
		return
	}

	var body struct {
		Horizontal bool   `json:"horizontal"`
		CWD        string `json:"cwd"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "Invalid JSON body")
		return
	}

	var resolvedCwd string
	if body.CWD != "" {
		if errMsg := validate.ValidatePath(body.CWD, "Working directory"); errMsg != "" {
			writeError(w, http.StatusBadRequest, errMsg)
			return
		}
		expanded, expandErr := validate.ExpandTilde(body.CWD)
		if expandErr != "" {
			writeError(w, http.StatusBadRequest, expandErr)
			return
		}
		resolvedCwd = expanded
	}

	server := serverFromRequest(r)
	paneID, err := s.tmux.SplitWindow(windowID, body.Horizontal, resolvedCwd, server)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	// Auto-focus the new pane. Best-effort: the split succeeded and the pane
	// exists, so a select failure must not turn the response into an error.
	_ = s.tmux.SelectPane(paneID, server)

	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "pane_id": paneID})
}

func (s *Server) handleClosePaneKill(w http.ResponseWriter, r *http.Request) {
	windowID, ok := parseWindowID(r)
	if !ok {
		writeError(w, http.StatusBadRequest, "Invalid window ID")
		return
	}

	if err := s.tmux.KillActivePane(windowID, serverFromRequest(r)); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) handleWindowMove(w http.ResponseWriter, r *http.Request) {
	windowID, ok := parseWindowID(r)
	if !ok {
		writeError(w, http.StatusBadRequest, "Invalid window ID")
		return
	}

	var body struct {
		TargetIndex *int `json:"targetIndex"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "Invalid JSON body")
		return
	}

	if body.TargetIndex == nil {
		writeError(w, http.StatusBadRequest, "targetIndex is required")
		return
	}
	if *body.TargetIndex < 0 {
		writeError(w, http.StatusBadRequest, "targetIndex must be a non-negative integer")
		return
	}

	if err := s.tmux.MoveWindow(windowID, *body.TargetIndex, serverFromRequest(r)); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) handleWindowMoveToSession(w http.ResponseWriter, r *http.Request) {
	windowID, ok := parseWindowID(r)
	if !ok {
		writeError(w, http.StatusBadRequest, "Invalid window ID")
		return
	}

	var body struct {
		TargetSession string `json:"targetSession"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "Invalid JSON body")
		return
	}

	if body.TargetSession == "" {
		writeError(w, http.StatusBadRequest, "targetSession is required")
		return
	}

	if errMsg := validate.ValidateName(body.TargetSession, "Target session name"); errMsg != "" {
		writeError(w, http.StatusBadRequest, errMsg)
		return
	}

	if err := s.tmux.MoveWindowToSession(windowID, body.TargetSession, serverFromRequest(r)); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// Allowlisted window-option keys for the /options endpoint. Only these keys may
// reach `tmux set-option` — any other client-supplied key is rejected with 400
// (constitution §I — closed key set bounds the injection/abuse surface, and a
// closed set is what makes per-key validation possible). The indexed
// @rk_win_web_<n> slots are matched by webTabIndex rather than one const per
// slot.
// optKeyLegacyURL/optKeyLegacyLens are the retired web option names, accepted
// for one release and translated onto the web-tab family (see
// translateLegacyOptionKeys).
const (
	optKeyColor     = tmux.ColorOption
	optKeyLayout    = tmux.LayoutOption
	optKeyWebActive = tmux.WebActiveOption
	optKeyCodeRoot  = tmux.CodeRootOption
	optKeyMarker    = tmux.MarkerOption
	optKeyRole      = tmux.RoleOption
	optKeyFlair     = tmux.FlairOption
	optKeyOwner     = tmux.OwnerOption
	optKeyNote      = tmux.NoteOption

	optKeyLegacyURL  = "@rk_win_url"
	optKeyLegacyLens = "@rk_win_lens"
)

// webTabIndex matches the indexed @rk_win_web_<n> allowlist keys, returning the
// 1-based slot. Slots above tmux.MaxWebTabs, the _root twins, and the _active
// pointer do NOT match — the pointer has its own const and everything else
// falls to the unknown-key 400.
func webTabIndex(key string) (int, bool) {
	const prefix = "@rk_win_web_"
	if !strings.HasPrefix(key, prefix) {
		return 0, false
	}
	n, err := strconv.Atoi(strings.TrimPrefix(key, prefix))
	if err != nil || n < 1 || n > tmux.MaxWebTabs {
		return 0, false
	}
	return n, true
}

// translateLegacyOptionKeys maps the retired @rk_win_url / @rk_win_lens keys
// onto the indexed web-tab family before validation:
//   - @rk_win_url: u  → the ACTIVE slot (slot 1 on an empty family) = u; the
//     caller arms @rk_win_web_active=1 when the family was empty.
//   - @rk_win_url: null → null on the ACTIVE slot (routed through WebRemove at
//     execution); on an empty family the retired write was an unset of an
//     unset option — a no-op.
//   - @rk_win_lens: "iframe" → @rk_win_layout = web, only when the
//     window has no layout yet and the batch doesn't set one explicitly; any
//     other value (or null) has no family representation — a no-op.
//
// compat: removed in the cleanup change (ui-state plan Change 5)
func translateLegacyOptionKeys(options map[string]*string, fam tmux.WebTabFamily) (map[string]*string, bool) {
	out := make(map[string]*string, len(options)+1)
	armActive := false
	for key, value := range options {
		switch key {
		case optKeyLegacyURL:
			slot := fam.Active
			if slot < 1 {
				slot = 1
			}
			if value == nil {
				if len(fam.Tabs) > 0 {
					out[tmux.WebTabOption(slot)] = nil
				}
				continue
			}
			out[tmux.WebTabOption(slot)] = value
			armActive = len(fam.Tabs) == 0
		case optKeyLegacyLens:
			if value == nil || *value != "iframe" || fam.Layout != "" {
				continue
			}
			if _, explicit := options[optKeyLayout]; explicit {
				continue
			}
			layout := "web"
			out[optKeyLayout] = &layout
		default:
			out[key] = value
		}
	}
	return out, armActive
}

// validateWindowOption enforces the per-key rules, returning a non-empty error
// message when value is invalid for key (the caller maps that to 400 before
// any tmux call). fam is the window's current web-tab family, read once per
// batch; appending reports whether the batch itself appends a tab (the slot at
// len+1 with a non-null value), so @rk_win_web_active may point at it.
func validateWindowOption(key string, value *string, fam tmux.WebTabFamily, appending bool) string {
	if n, ok := webTabIndex(key); ok {
		// The family is dense on every write path: a direct write may only
		// replace an existing slot or append at len+1; a null write routes
		// through WebRemove(n) at execution so density holds (a bare unset
		// would leave a hole).
		if value == nil {
			if n > len(fam.Tabs) {
				return fmt.Sprintf("web tab %d does not exist", n)
			}
			return ""
		}
		if strings.TrimSpace(*value) == "" {
			return "URL cannot be empty"
		}
		if errMsg := validate.ValidateWebTabURL(*value); errMsg != "" {
			return errMsg
		}
		if n > len(fam.Tabs)+1 {
			return fmt.Sprintf("web tab %d would leave a gap (next slot is %d)", n, len(fam.Tabs)+1)
		}
		return ""
	}
	if value == nil {
		// null = unset, valid for every other key except the active pointer on
		// a non-empty family (the pointer must always address a live tab).
		if key == optKeyWebActive && len(fam.Tabs) > 0 {
			return "@rk_win_web_active cannot be unset while tabs exist"
		}
		return ""
	}
	switch key {
	case optKeyColor:
		// Color value descriptor: a single index ("4", 0–15) or a two-hue
		// blend ("1+3", each component 0–15). Validated via the shared rule.
		if errMsg := validate.ValidateColorValue(*value); errMsg != "" {
			return errMsg
		}
	case optKeyLayout:
		// The layout grammar (internal/layoutspec): the tree form
		// (h(tty,v(code,web))) or a legacy preset string — the value is
		// stored verbatim, never canonicalised. Empty unsets.
		if *value != "" {
			if _, err := layoutspec.Parse(*value); err != nil {
				return err.Error()
			}
		}
	case optKeyWebActive:
		n, err := strconv.Atoi(*value)
		max := len(fam.Tabs)
		if appending {
			max++
		}
		if err != nil || n < 1 || n > max {
			return fmt.Sprintf("@rk_win_web_active must be an integer in 1..%d", max)
		}
	case optKeyCodeRoot:
		// An absolute folder (after tilde expansion); empty unsets.
		if *value != "" {
			if errMsg := validate.ValidatePath(*value, "Code root"); errMsg != "" {
				return errMsg
			}
			if _, expandErr := validate.ExpandTilde(*value); expandErr != "" {
				return expandErr
			}
		}
	case optKeyMarker:
		// Left-gutter marker: a `<mode>[:<stage>]` token (manual/auto/blocked ×
		// 1/2/3, bare mode = stage 1). An empty string is valid and treated as
		// unset below (mirroring @rk_win_lens).
		if errMsg := validate.ValidateMarkerValue(*value); errMsg != "" {
			return errMsg
		}
	case optKeyRole:
		// Orchestration role: "operator" (or empty to clear). An empty string
		// is valid and treated as unset below (mirroring @rk_win_marker).
		if errMsg := validate.ValidateRoleValue(*value); errMsg != "" {
			return errMsg
		}
	case optKeyFlair:
		// Per-row flair decoration: one of nyan/naruto/onepiece (or empty to
		// clear). An empty string is valid and treated as unset below
		// (mirroring @rk_win_marker).
		if errMsg := validate.ValidateFlairValue(*value); errMsg != "" {
			return errMsg
		}
	case optKeyOwner:
		// Operator-ownership trail: "operator" (or empty to clear). An empty
		// string is valid and treated as unset below (mirroring
		// @rk_win_marker).
		if errMsg := validate.ValidateOwnerValue(*value); errMsg != "" {
			return errMsg
		}
	case optKeyNote:
		// Free-text one-line status note: trimmed, length-capped, and free of
		// control characters (the shared rule — tabs/newlines would corrupt the
		// tab-delimited list-windows read format). Empty and whitespace-only
		// strings are valid and treated as unset below (mirroring
		// @rk_win_marker).
		if _, errMsg := validate.ValidateNoteText(*value); errMsg != "" {
			return errMsg
		}
	}
	return ""
}

// buildWindowOptionOps turns a validated batch into the chained SetWindowOptions
// ops plus the slots to remove (a null on @rk_win_web_<n> routes through
// WebRemove at execution, never a bare unset). Empty-string values map to
// unsets for the clearable keys; @rk_win_note is epoch-stamped at write time;
// @rk_win_code_root is stored tilde-expanded. armActive prepends the compat
// shim's @rk_win_web_active=1 (a legacy URL write onto an empty family).
func buildWindowOptionOps(options map[string]*string, armActive bool) (ops []tmux.WindowOptionOp, removeSlots []int, roleSet, roleClear bool) {
	if armActive {
		one := "1"
		ops = append(ops, tmux.WindowOptionOp{Key: optKeyWebActive, Value: &one})
	}
	for key, value := range options {
		if n, ok := webTabIndex(key); ok && value == nil {
			removeSlots = append(removeSlots, n)
			continue
		}
		op := tmux.WindowOptionOp{Key: key, Value: value}
		// An empty string means unset for @rk_win_layout (revert to the
		// bare-tty render), @rk_win_marker, @rk_win_role, @rk_win_flair,
		// @rk_win_owner, @rk_win_note, and @rk_win_code_root — the same
		// "empty clears" contract the retired @rk_win_lens carried.
		if value != nil && *value == "" {
			switch key {
			case optKeyLayout, optKeyMarker, optKeyRole, optKeyFlair, optKeyOwner, optKeyNote, optKeyCodeRoot:
				op.Value = nil
			}
		}
		// @rk_win_note: clients send bare text; the server owns the clock and stamps
		// the "<unix-epoch>:" prefix at write time (no client-skew lies — agents
		// writing raw set-option stamp their own epoch via $(date +%s)). A value
		// that trims to nothing is an unset, never a bare "<epoch>:" stamp.
		if key == optKeyNote && op.Value != nil {
			trimmed := strings.TrimSpace(*op.Value)
			if trimmed == "" {
				op.Value = nil
			} else {
				stamped := fmt.Sprintf("%d:%s", time.Now().Unix(), trimmed)
				op.Value = &stamped
			}
		}
		if key == optKeyCodeRoot && op.Value != nil {
			if expanded, expandErr := validate.ExpandTilde(*op.Value); expandErr == "" {
				op.Value = &expanded
			}
		}
		if key == optKeyRole {
			if op.Value != nil {
				roleSet = true
			} else {
				roleClear = true
			}
		}
		ops = append(ops, op)
	}
	// Removal shifts slots down, so removes run highest-first to keep the
	// lower indexes stable.
	sort.Sort(sort.Reverse(sort.IntSlice(removeSlots)))
	return ops, removeSlots, roleSet, roleClear
}

// handleWindowOptions applies a partial-merge of window options to {windowId}.
// POST /api/windows/{windowId}/options ← {"options": {"@rk_win_color": "5",
// "@rk_win_web_2": "/proxy/3000/", "@rk_win_layout": null, "@rk_win_marker": "manual:1"}}
// → 200 {"ok": true}.
//
// Semantics: only keys present in `options` are touched; a present key with a
// non-null value sets it, an explicit null unsets it (a null on a web slot
// routes through WebRemove so the family stays dense). The retired
// @rk_win_url/@rk_win_lens keys are translated onto the web-tab family first
// (see translateLegacyOptionKeys). ALL keys are validated (allowlist + per-key
// rules) before any tmux call — if any key fails, the endpoint returns 400 and
// issues zero tmux calls (no partial application). The whole merge then
// executes as one \;-chained tmux invocation via the shared SetWindowOptions
// primitive.
func (s *Server) handleWindowOptions(w http.ResponseWriter, r *http.Request) {
	windowID, ok := parseWindowID(r)
	if !ok {
		writeError(w, http.StatusBadRequest, "Invalid window ID")
		return
	}

	var body struct {
		Options map[string]*string `json:"options"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "Invalid JSON body")
		return
	}

	// Allowlist first — an unknown key rejects the whole batch before any
	// family read or tmux call.
	for key := range body.Options {
		if _, isSlot := webTabIndex(key); isSlot {
			continue
		}
		switch key {
		case optKeyColor, optKeyLayout, optKeyWebActive, optKeyCodeRoot,
			optKeyMarker, optKeyRole, optKeyFlair, optKeyOwner, optKeyNote,
			optKeyLegacyURL, optKeyLegacyLens:
		default:
			writeError(w, http.StatusBadRequest, "Unknown option key: "+key)
			return
		}
	}

	server := serverFromRequest(r)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	// Legacy-key translation and family-relative validation both need the
	// window's current web-tab family — read once, only when a family-relative
	// key is present.
	var fam tmux.WebTabFamily
	for key := range body.Options {
		if _, isSlot := webTabIndex(key); isSlot || key == optKeyWebActive || key == optKeyLegacyURL || key == optKeyLegacyLens {
			var err error
			fam, err = webTabFamilyFn(ctx, windowID, server)
			if err != nil {
				writeError(w, http.StatusInternalServerError, err.Error())
				return
			}
			break
		}
	}

	options, armActive := translateLegacyOptionKeys(body.Options, fam)

	// Validate-all-then-execute: a single invalid key aborts with zero tmux
	// calls. appending (computed batch-wide first — map iteration order is
	// random) lets the active pointer target the slot the batch itself appends.
	appending := false
	for key, value := range options {
		if n, ok := webTabIndex(key); ok && value != nil && n == len(fam.Tabs)+1 {
			appending = true
			break
		}
	}
	for key, value := range options {
		if errMsg := validateWindowOption(key, value, fam, appending); errMsg != "" {
			writeError(w, http.StatusBadRequest, errMsg)
			return
		}
	}
	if mixedWebRemoveBatch(options) {
		writeError(w, http.StatusBadRequest, "a web tab removal (null) cannot be combined with other web-tab writes in one request")
		return
	}

	// Live-in-one-place check (a layout write introducing a foreign leaf
	// already held by another window): only a layout value carrying a foreign
	// leaf can conflict, so the server window fetch is gated on that.
	if value, ok := options[optKeyLayout]; ok && value != nil && *value != "" {
		if tree, err := layoutspec.Parse(*value); err == nil && tree.HasForeign() {
			windows, err := s.fetchServerWindows(ctx, server)
			if err != nil {
				writeError(w, http.StatusInternalServerError, err.Error())
				return
			}
			if err := tmux.CheckLiveInOnePlace(tree, windowID, windows); err != nil {
				var held *tmux.LeafHeldError
				if errors.As(err, &held) {
					writeError(w, http.StatusConflict, err.Error())
					return
				}
				writeError(w, http.StatusBadRequest, err.Error())
				return
			}
		}
	}

	ops, removeSlots, roleSet, roleClear := buildWindowOptionOps(options, armActive)

	if len(ops) == 0 && len(removeSlots) == 0 {
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
		return
	}

	// Setting @rk_win_role=operator is a server-scoped radio: clear the role from
	// every other window on the server BEFORE the batched set, so at most one
	// window carries it. Enforcement lives here (server-side), never in clients.
	var displaced []string
	if roleSet {
		var err error
		displaced, err = s.tmux.ClearWindowRoleExceptOnServer(ctx, server, windowID)
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
	}

	if err := s.tmux.SetWindowOptions(ctx, windowID, server, ops); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	for _, n := range removeSlots {
		if err := webRemoveFn(ctx, windowID, server, n); err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
	}

	// Physical promotion, trailing the option write (option-write-first): a
	// mid-sequence failure degrades to the cosmetic-only state (role set,
	// window unmoved) — never a moved-but-roleless stray.
	if roleSet {
		// Demote displaced carriers out of the operator session first, then
		// move the new operator in — an emptied operator session dies with its
		// last window, and ensure-before-move recreates it.
		for _, id := range displaced {
			if err := s.tmux.DemoteWindowFromOperatorSessionOnServer(ctx, server, id); err != nil {
				writeError(w, http.StatusInternalServerError, err.Error())
				return
			}
		}
		if err := s.tmux.MoveWindowIntoOperatorSessionOnServer(ctx, server, windowID); err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
	} else if roleClear {
		// Demote: a member of the operator session moves out to its cwd-basename
		// session; a non-member is a plain unset (no-op move).
		if err := s.tmux.DemoteWindowFromOperatorSessionOnServer(ctx, server, windowID); err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
	}

	// Wake the SSE hub so the option change (color/marker/note/layout/web-tab
	// family) surfaces on the next poll pass instead of the 12s safety tick —
	// set-option is invisible to the tmuxctl control-mode parser, so no
	// subscriber notification fires. Mirrors handleSessionOrderPost's
	// initSSEHub-then-hub-call pattern; initSSEHub is idempotent. Only reached
	// on a successful tmux write (validation/tmux errors returned early above).
	s.initSSEHub()
	s.sseHub.wake(server)

	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) handleWindowKeys(w http.ResponseWriter, r *http.Request) {
	windowID, ok := parseWindowID(r)
	if !ok {
		writeError(w, http.StatusBadRequest, "Invalid window ID")
		return
	}

	var body struct {
		Keys string `json:"keys"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "Invalid JSON body")
		return
	}

	if strings.TrimSpace(body.Keys) == "" {
		writeError(w, http.StatusBadRequest, "Keys cannot be empty")
		return
	}

	if err := s.tmux.SendKeys(windowID, body.Keys, serverFromRequest(r)); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// mixedWebRemoveBatch reports whether a batch removes a web slot (null) AND
// writes another slot or the active pointer. A removal renumbers the family
// after the chained set runs, so such a batch has no single meaning — the
// other write addresses a pre-shift index the caller cannot see post-shift.
// Rejected up front; callers sequence two requests. Multiple removals alone
// are fine (they execute highest-first, so lower indexes stay stable).
func mixedWebRemoveBatch(options map[string]*string) bool {
	removes, others := false, false
	for key, value := range options {
		if _, ok := webTabIndex(key); ok {
			if value == nil {
				removes = true
			} else {
				others = true
			}
			continue
		}
		if key == optKeyWebActive {
			others = true
		}
	}
	return removes && others
}
