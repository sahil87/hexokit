package api

// Cross-tab layout verbs (docs/specs/surface-layout.md): a surface is live in
// exactly one tab, so moving it between tabs is a server-recomputed two-window
// write through one \;-chained tmux invocation (tmux.SetWindowLayouts). The
// chain is ordered — the holder's removal lands before the target's write —
// and the read-modify-write behind it is serialized by layoutWriteMu, but it
// is NOT atomic: a reader polling mid-chain can transiently observe the leaf
// in neither tab. Both endpoints validate every body field BEFORE any tmux
// call (Constitution I) and map failures to 400 (bad body / invalid tree),
// 404 (unknown window), 409 (state conflict).

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"rk/internal/layoutspec"
	"rk/internal/tmux"
	"rk/internal/validate"
)

// fetchServerWindows flattens one FetchSessions pass into the server's window
// set — the holder-lookup input for every layout write check (borrow, return,
// and the /options live-in-one-place gate).
func (s *Server) fetchServerWindows(ctx context.Context, server string) ([]tmux.WindowInfo, error) {
	snap, err := s.sessions.FetchSessions(ctx, server)
	if err != nil {
		return nil, err
	}
	var out []tmux.WindowInfo
	for _, sess := range snap {
		out = append(out, sess.Windows...)
	}
	return out, nil
}

// windowByID locates a window in the fetched server set.
func windowByID(windows []tmux.WindowInfo, id string) (tmux.WindowInfo, bool) {
	for _, w := range windows {
		if w.WindowID == id {
			return w, true
		}
	}
	return tmux.WindowInfo{}, false
}

// parseStoredLayout tolerantly reads a window's stored layout: an unset or
// unparseable value degrades to the bare tty leaf (the frontend's
// effectiveLayout fallback), never an error.
func parseStoredLayout(raw string) layoutspec.Node {
	tree, err := layoutspec.Parse(raw)
	if err != nil {
		return layoutspec.Default()
	}
	return tree
}

// handleLayoutBorrow moves a surface leaf into another tab.
// POST /api/layout/borrow?server= ← {"to":"@B","leaf":"@A/<kind>","tree":"<B's new tree>"}
// → 200 {"ok": true}.
//
// The tree is validated for the target window and must contain the leaf. Every
// OTHER foreign leaf in it must pass the live-in-one-place check (409 on a
// third-window holder — the /options gate's rule); body.Leaf itself is exempt,
// its current holder being the intended move source. That holder C (if any,
// C ≠ to) is located from live tmux state; C's tree minus the leaf
// (normalised, bare-tty fallback when it empties) and the target's new tree
// are written in ONE chained invocation. With no holder only the target is
// written.
func (s *Server) handleLayoutBorrow(w http.ResponseWriter, r *http.Request) {
	var body struct {
		To   string `json:"to"`
		Leaf string `json:"leaf"`
		Tree string `json:"tree"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "Invalid JSON body")
		return
	}
	if errMsg := validate.ValidateWindowID(body.To, "Window ID"); errMsg != "" {
		writeError(w, http.StatusBadRequest, errMsg)
		return
	}
	if _, _, ok := layoutspec.ParseLeafAddress(body.Leaf); !ok {
		writeError(w, http.StatusBadRequest, "Invalid leaf address: "+body.Leaf)
		return
	}
	tree, err := layoutspec.Parse(body.Tree)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := layoutspec.ValidateFor(tree, body.To); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	leafPresent := false
	for _, id := range tree.LeafIDs() {
		if id == body.Leaf {
			leafPresent = true
			break
		}
	}
	if !leafPresent {
		writeError(w, http.StatusBadRequest, "tree does not contain leaf "+body.Leaf)
		return
	}

	server := serverFromRequest(r)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	// The fetch-validate-write below commits from one snapshot; the lock keeps
	// a concurrent borrow/return from deciding on it and overwriting the move.
	s.layoutWriteMu.Lock()
	defer s.layoutWriteMu.Unlock()

	windows, err := s.fetchServerWindows(ctx, server)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if _, ok := windowByID(windows, body.To); !ok {
		writeError(w, http.StatusNotFound, "unknown window: "+body.To)
		return
	}
	// The leaf's home window must exist — otherwise the write stores a leaf
	// the next read prunes and reports success for a move that never renders.
	home, _, _ := layoutspec.ParseLeafAddress(body.Leaf)
	if _, ok := windowByID(windows, home); !ok {
		writeError(w, http.StatusNotFound, "unknown window: "+home)
		return
	}

	// Live-in-one-place on the posted tree: a second foreign leaf already held
	// by a third window would be silently stolen by this write — the /options
	// gate rejects exactly that. body.Leaf is exempt: its current holder is
	// the intended move source, so its held state is expected.
	if err := tmux.CheckLiveInOnePlaceExcept(tree, body.To, windows, body.Leaf); err != nil {
		var held *tmux.LeafHeldError
		if errors.As(err, &held) {
			writeError(w, http.StatusConflict, err.Error())
			return
		}
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	// The holder's removal writes first within the chain so the leaf is never
	// added to the target while the holder still shows it.
	pairs := []tmux.WindowLayoutWrite{{WindowID: body.To, Layout: body.Tree}}
	if holder, held := tmux.LeafHolder(windows, body.Leaf, body.To); held {
		holderWin, _ := windowByID(windows, holder)
		if minus, ok := layoutspec.RemoveOrTTY(parseStoredLayout(holderWin.Layout), body.Leaf); ok {
			pairs = []tmux.WindowLayoutWrite{
				{WindowID: holder, Layout: minus.String()},
				{WindowID: body.To, Layout: body.Tree},
			}
		}
	}
	if err := s.tmux.SetWindowLayouts(ctx, server, pairs); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	// set-option emits no control-mode event — wake the hub so the move
	// repaints on the next poll pass (the handleWindowOptions pattern).
	s.initSSEHub()
	s.sseHub.wake(server)

	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// handleLayoutReturn sends a held surface leaf back to its home window.
// POST /api/layout/return?server= ← {"from":"@B","leaf":"@A/<kind>"}
// → 200 {"ok": true}.
//
// Both trees are recomputed from current tmux state: the holder B's tree
// minus the leaf (bare-tty fallback when it empties) and — only when the home
// window A is alive AND its layout no longer carries a bare <kind> slot (a
// foreign leaf of the same kind does not count) — A's tree with <kind>
// re-added by the generic add rule. Both writes chain in one invocation; a
// live A still holding its slot means only B is written; a dead A simply
// removes the leaf from B. A leaf B does not hold is a 409, and so is a
// failed home re-add — in both cases nothing is written.
func (s *Server) handleLayoutReturn(w http.ResponseWriter, r *http.Request) {
	var body struct {
		From string `json:"from"`
		Leaf string `json:"leaf"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "Invalid JSON body")
		return
	}
	if errMsg := validate.ValidateWindowID(body.From, "Window ID"); errMsg != "" {
		writeError(w, http.StatusBadRequest, errMsg)
		return
	}
	home, kind, ok := layoutspec.ParseLeafAddress(body.Leaf)
	if !ok {
		writeError(w, http.StatusBadRequest, "Invalid leaf address: "+body.Leaf)
		return
	}

	server := serverFromRequest(r)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	// Same read-modify-write serialization as the borrow endpoint.
	s.layoutWriteMu.Lock()
	defer s.layoutWriteMu.Unlock()

	windows, err := s.fetchServerWindows(ctx, server)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	holder, ok := windowByID(windows, body.From)
	if !ok {
		writeError(w, http.StatusNotFound, "unknown window: "+body.From)
		return
	}
	holderTree := parseStoredLayout(holder.Layout)
	holderNext, held := layoutspec.RemoveOrTTY(holderTree, body.Leaf)
	if !held {
		writeError(w, http.StatusConflict, "window "+body.From+" does not hold "+body.Leaf)
		return
	}

	pairs := []tmux.WindowLayoutWrite{{WindowID: body.From, Layout: holderNext.String()}}
	// home != from: a self-naming leaf (invalid, tolerated on read) is just
	// removed — re-adding the slot would rewrite the same window and resurrect
	// the leaf.
	if home != body.From {
		if homeWin, alive := windowByID(windows, home); alive {
			homeTree := parseStoredLayout(homeWin.Layout)
			if !homeTree.HasBare(kind) {
				homeNext, err := layoutspec.Add(homeTree, kind)
				if err != nil {
					writeError(w, http.StatusConflict, err.Error())
					return
				}
				pairs = append(pairs, tmux.WindowLayoutWrite{WindowID: home, Layout: homeNext.String()})
			}
		}
	}
	if err := s.tmux.SetWindowLayouts(ctx, server, pairs); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	s.initSSEHub()
	s.sseHub.wake(server)

	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}
