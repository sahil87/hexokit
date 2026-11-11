package tmux

import (
	"context"
	"fmt"
	"log/slog"
	"regexp"
	"sort"
	"strings"
)

// Board membership is derived entirely from single-window pin-sessions
// (`_rk-pin-*`) and their session-scoped user options — there is no
// `@rk_ses_pin_board` server-option encoding (Constitution II: state derived
// from tmux). A board is the set of pin-sessions sharing a
// `@rk_ses_pin_board` value.
//
//   - @rk_ses_pin_board — which board this pinned window belongs to
//   - @rk_ses_pin_home  — the home session to restore the window to on unpin
//   - @rk_ses_pin_order — fractional order key within the board (ComputeOrderKey)
const (
	BoardOption      = "@rk_ses_pin_board"
	HomeOption       = "@rk_ses_pin_home"
	BoardOrderOption = "@rk_ses_pin_order"
)

// BoardEntry represents a single (server, windowID) pin to a named board,
// derived from a `_rk-pin-*` session's vars.
type BoardEntry struct {
	Server   string `json:"server"`
	WindowID string `json:"windowId"`
	Board    string `json:"board"`
	OrderKey string `json:"orderKey"`
}

// BoardSummary is a per-board pin count returned by ListBoards.
type BoardSummary struct {
	Name     string `json:"name"`
	PinCount int    `json:"pinCount"`
}

var (
	boardNamePattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,32}$`)
	windowIDPattern  = regexp.MustCompile(`^@\d+$`)
	orderKeyPattern  = regexp.MustCompile(`^[a-z]{1,16}$`)
)

// ValidBoardName reports whether name is a syntactically valid board name.
// Pattern: alphanumeric + hyphen + underscore, length 1-32.
func ValidBoardName(name string) bool {
	return boardNamePattern.MatchString(name)
}

// ValidWindowID reports whether id matches tmux's `#{window_id}` form (`@<digits>`).
func ValidWindowID(id string) bool {
	return windowIDPattern.MatchString(id)
}

// ValidOrderKey reports whether key is a valid lexicographic order key
// (1-16 lowercase ASCII letters).
func ValidOrderKey(key string) bool {
	return orderKeyPattern.MatchString(key)
}

// isAbsentOption returns true when err is one of the operational tmux states
// that map to "no entries" rather than a real error: option unset, no server
// running, or socket not connectable.
func isAbsentOption(err error) bool {
	if err == nil {
		return false
	}
	msg := err.Error()
	return strings.Contains(msg, "invalid option") ||
		strings.Contains(msg, "unknown option") ||
		strings.Contains(msg, "no server running") ||
		strings.Contains(msg, "failed to connect")
}

// showSessionOption reads a single session-scoped user option from a session,
// returning "" (no error) when the option is unset or the server is
// unreachable. Other failures propagate.
func showSessionOption(ctx context.Context, server, session, option string) (string, error) {
	out, err := tmuxExecRawServer(ctx, server, "show-options", "-v", "-t", ExactSessionTarget(session), option)
	if err != nil {
		if isAbsentOption(err) {
			return "", nil
		}
		return "", fmt.Errorf("read %s on %s/%s: %w", option, server, session, err)
	}
	return strings.TrimSpace(out), nil
}

// setSessionOption sets a session-scoped user option on a session. The value
// is validated by the caller and passed as a discrete arg (no shell string,
// constitution §I). The generic setter behind the per-channel session-option
// wrappers (SetSessionColor/SetSessionFlair) and the board pin-session vars.
func setSessionOption(ctx context.Context, server, session, option, value string) error {
	_, err := tmuxExecRawServer(ctx, server, "set-option", "-t", ExactSessionTarget(session), option, value)
	return err
}

// unsetSessionOption removes a session-scoped user option from a session.
// Mirrors setSessionOption.
func unsetSessionOption(ctx context.Context, server, session, option string) error {
	_, err := tmuxExecRawServer(ctx, server, "set-option", "-u", "-t", ExactSessionTarget(session), option)
	return err
}

// pinEntry derives the BoardEntry for a single pin-session by reading its
// session vars. Returns (entry, true, nil) when the session carries a valid
// @rk_ses_pin_board value; (zero, false, nil) when it is not a board pin (no/invalid
// @rk_ses_pin_board) — a defensive skip rather than an error.
func pinEntry(ctx context.Context, server, pinSession string) (BoardEntry, bool, error) {
	windowID, ok := WindowIDFromPinSession(pinSession)
	if !ok {
		return BoardEntry{}, false, nil
	}
	board, err := showSessionOption(ctx, server, pinSession, BoardOption)
	if err != nil {
		return BoardEntry{}, false, err
	}
	if !ValidBoardName(board) {
		// Not a board pin (or malformed) — skip without error.
		return BoardEntry{}, false, nil
	}
	orderKey, err := showSessionOption(ctx, server, pinSession, BoardOrderOption)
	if err != nil {
		return BoardEntry{}, false, err
	}
	if !ValidOrderKey(orderKey) {
		orderKey = initialAppendKey
	}
	return BoardEntry{
		Server:   server,
		WindowID: windowID,
		Board:    board,
		OrderKey: orderKey,
	}, true, nil
}

// ListBoardEntries returns the pinned-window entries on the named server,
// derived from its `_rk-pin-*` sessions. Returns ([]BoardEntry{}, nil) when no
// pin-sessions exist or the server is not reachable — normal operational states.
func ListBoardEntries(ctx context.Context, server string) ([]BoardEntry, error) {
	ctx, cancel := context.WithTimeout(ctx, TmuxTimeout)
	defer cancel()

	pins, err := ListPinSessionNames(ctx, server)
	if err != nil {
		if isAbsentOption(err) {
			return []BoardEntry{}, nil
		}
		return nil, fmt.Errorf("list pin sessions on %s: %w", server, err)
	}
	out := make([]BoardEntry, 0, len(pins))
	for _, pin := range pins {
		entry, ok, derr := pinEntry(ctx, server, pin)
		if derr != nil {
			slog.Warn("board: pin-session var read failed", "server", server, "pin", pin, "err", derr)
			continue
		}
		if !ok {
			continue
		}
		out = append(out, entry)
	}
	return out, nil
}

// ListBoards returns the alphabetical per-board pin-count summary across all
// reachable servers, derived from pin-sessions. A board exists only while at
// least one pin-session carries its name (no empty boards, no registry).
func ListBoards(ctx context.Context) ([]BoardSummary, error) {
	servers, err := ListServers(ctx)
	if err != nil {
		return nil, fmt.Errorf("list servers: %w", err)
	}
	if len(servers) == 0 {
		servers = []string{"default"}
	}
	counts := make(map[string]int)
	for _, s := range servers {
		entries, lerr := ListBoardEntries(ctx, s)
		if lerr != nil {
			slog.Warn("board: ListBoardEntries failed", "server", s, "err", lerr)
			continue
		}
		for _, e := range entries {
			counts[e.Board]++
		}
	}
	out := make([]BoardSummary, 0, len(counts))
	for name, count := range counts {
		out = append(out, BoardSummary{Name: name, PinCount: count})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, nil
}

// GetBoard returns entries for a single board across all reachable servers,
// sorted by order key. Membership is derived live from pin-sessions, so there
// is no stale entry to clean up — a killed pinned window's session simply
// disappears from the listing.
func GetBoard(ctx context.Context, name string) ([]BoardEntry, error) {
	if !ValidBoardName(name) {
		return nil, fmt.Errorf("invalid board name")
	}
	servers, err := ListServers(ctx)
	if err != nil {
		return nil, fmt.Errorf("list servers: %w", err)
	}
	if len(servers) == 0 {
		servers = []string{"default"}
	}
	out := make([]BoardEntry, 0)
	for _, s := range servers {
		entries, lerr := ListBoardEntries(ctx, s)
		if lerr != nil {
			slog.Warn("board: ListBoardEntries failed", "server", s, "err", lerr)
			continue
		}
		for _, e := range entries {
			if e.Board == name {
				out = append(out, e)
			}
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].OrderKey < out[j].OrderKey })
	return out, nil
}

// initialAppendKey is the first order key assigned when a board has no
// entries. Using a midpoint letter leaves headroom for both prepend and
// append operations, which is important since the alphabet has no
// representation strictly less than "a".
const initialAppendKey = "m"

// nextAppendKey returns an order key strictly greater than the largest existing
// key among the supplied board entries (lexicographic). Empty → initialAppendKey.
func nextAppendKey(entries []BoardEntry) string {
	maxKey := ""
	for _, e := range entries {
		if e.OrderKey > maxKey {
			maxKey = e.OrderKey
		}
	}
	if maxKey == "" {
		return initialAppendKey
	}
	next, err := ComputeOrderKey(maxKey, "")
	if err != nil {
		return maxKey + "a"
	}
	return next
}

// Pin LINKS the window identified by windowID into its own single-window
// pin-session `_rk-pin-<id>` and records its board membership. The window STAYS
// a member of its home session (visible natively in the SESSIONS sidebar at its
// original index — tmux never removed it) and simultaneously becomes the sole
// window of the pin-session, which grants a board pane a direct attach target
// with an independent current-window pointer. Dual membership is what keeps the
// sidebar honest (Constitution II — tmux says the window is home) while the
// board still derives entirely from `_rk-pin-*` session options.
//
// Idempotent: if `_rk-pin-<id>` already exists, Pin is a no-op (no re-link, no
// order-key churn) when the board matches, and re-stamps `@rk_ses_pin_board` when it
// differs.
//
// Security (Constitution §I): windowID and board are validated before any
// subprocess; every tmux call is ctx+timeout-scoped via the package exec
// helpers with explicit argument slices (no shell strings).
func Pin(ctx context.Context, server, windowID, board string) error {
	ctx, cancel := context.WithTimeout(ctx, TmuxTimeout)
	defer cancel()
	if !ValidWindowID(windowID) {
		return fmt.Errorf("invalid window id")
	}
	if !ValidBoardName(board) {
		return fmt.Errorf("invalid board name")
	}
	pinSession, ok := PinSessionName(windowID)
	if !ok {
		return fmt.Errorf("invalid window id")
	}

	// Idempotency: the pin-session already exists → the window is already pinned.
	// Re-pin makes the requested board win and repairs the order key if it went
	// missing, so the pin is always board-derivable and sortable. We do NOT try to
	// repair @rk_ses_pin_home here: @rk_ses_pin_home durability is guaranteed at creation by the
	// stamp-before-link ordering below (it is written while the pin-session is
	// still empty, so the window never enters a pin-session lacking @rk_ses_pin_home).
	// A window has exactly one pin-session, so this is the sole authoritative
	// place its board membership lives.
	if _, err := tmuxExecRawServer(ctx, server, "has-session", "-t", ExactSessionTarget(pinSession)); err == nil {
		// @rk_ses_pin_board: always set to the requested board (different-board re-pin must
		// not silently keep the old board; same-board is a harmless idempotent set).
		if err := setSessionOption(ctx, server, pinSession, BoardOption, board); err != nil {
			return fmt.Errorf("re-stamp %s on existing pin %q: %w", BoardOption, pinSession, err)
		}
		// @rk_ses_pin_order: repair only if missing/invalid so GetBoard can sort it.
		curOrder, oerr := showSessionOption(ctx, server, pinSession, BoardOrderOption)
		if oerr != nil {
			return fmt.Errorf("read %s on existing pin %q: %w", BoardOrderOption, pinSession, oerr)
		}
		if !ValidOrderKey(curOrder) {
			if err := setSessionOption(ctx, server, pinSession, BoardOrderOption, initialAppendKey); err != nil {
				return fmt.Errorf("repair %s on existing pin %q: %w", BoardOrderOption, pinSession, err)
			}
		}
		return nil
	}

	// Resolve the home session to remember for unpin. The window must currently
	// live in a home session (not already a pin-session).
	home, err := ResolveWindowSession(ctx, server, windowID)
	if err != nil {
		return fmt.Errorf("resolve home session: %w", err)
	}

	// Compute the append key restricted to this board BEFORE the link (board
	// membership is read from existing pin-sessions, which excludes this window
	// until its pin-session is created below).
	entries, err := ListBoardEntries(ctx, server)
	if err != nil {
		return err
	}
	boardEntries := make([]BoardEntry, 0)
	for _, e := range entries {
		if e.Board == board {
			boardEntries = append(boardEntries, e)
		}
	}
	orderKey := nextAppendKey(boardEntries)

	// Create the pin-session (starts with one placeholder window) and capture the
	// placeholder window's ID so we can kill it after the link, leaving the linked
	// window as the session's sole window. Capturing the placeholder ID (rather
	// than assuming index 0) is robust to base-index config and to the linked
	// window's landing index.
	//
	// `-c ServerBirthDir()` anchors the pin-session's session_path to the
	// operator's home (fallback "/") so it never dangles. Without it the path
	// defaults to the tmux SERVER's own CWD, which can be a deleted directory.
	// This is session_path hygiene on an already-live server — distinct from
	// the cmd.Dir server-birth pins (the server exists by Pin time), hence the
	// tmux `-c` flag rather than an exec working-directory override.
	if _, err := tmuxExecServer(ctx, server, "new-session", "-d", "-s", pinSession, "-c", ServerBirthDir()); err != nil {
		return fmt.Errorf("create pin session: %w", err)
	}
	placeholderLines, err := tmuxExecServer(ctx, server, "list-windows", "-t", ExactSessionTarget(pinSession), "-F", "#{window_id}")
	if err != nil || len(placeholderLines) == 0 {
		// Roll back the empty pin-session. Root the teardown in context.Background():
		// Pin's ctx may already be at/near its deadline, and KillSessionCtx wraps the
		// passed ctx with WithTimeout — a cancelled parent would make the kill a no-op
		// and orphan the session (the same reason relay.go roots teardown in Background).
		_ = KillSessionCtx(context.Background(), server, pinSession)
		if err != nil {
			return fmt.Errorf("read pin placeholder window: %w", err)
		}
		return fmt.Errorf("read pin placeholder window: pin-session %q reported no windows", pinSession)
	}
	placeholderID := strings.TrimSpace(placeholderLines[0])

	// STAMP-BEFORE-LINK: write all three membership vars onto the (still empty)
	// pin-session BEFORE linking the target window in. Ordering is load-bearing for
	// crash/failure safety:
	//   - The window has NOT been linked yet, so a stamp failure strands nothing —
	//     we simply kill the empty placeholder-only pin-session and return; the
	//     window is untouched in its home session.
	//   - Once the link succeeds (below), @rk_ses_pin_home is already durably present, so
	//     the window can ALWAYS be unpinned. There is no window-linked-but-unstamped
	//     window, hence no double-fault rollback, no "un-unpinnable" pin-session,
	//     and the idempotent recovery story is trivially true.
	stampRollback := func(cause error, opt string) error {
		_ = KillSessionCtx(context.Background(), server, pinSession)
		return fmt.Errorf("set %s on new pin %q: %w", opt, pinSession, cause)
	}
	if err := setSessionOption(ctx, server, pinSession, HomeOption, home); err != nil {
		return stampRollback(err, HomeOption)
	}
	if err := setSessionOption(ctx, server, pinSession, BoardOption, board); err != nil {
		return stampRollback(err, BoardOption)
	}
	if err := setSessionOption(ctx, server, pinSession, BoardOrderOption, orderKey); err != nil {
		return stampRollback(err, BoardOrderOption)
	}

	// Now link the window in. The pin-session is fully stamped, so a successful
	// link yields a complete, unpinnable pin. A link FAILURE strands nothing (the
	// window stays home) — roll back the stamped-but-windowless pin-session. The
	// window stays a member of its home session too (link, not move).
	if err := LinkWindowToSession(windowID, pinSession, server); err != nil {
		_ = KillSessionCtx(context.Background(), server, pinSession)
		return fmt.Errorf("link window into pin session: %w", err)
	}
	if _, err := tmuxExecServer(ctx, server, "kill-window", "-t", placeholderID); err != nil {
		// Non-fatal: a stray placeholder is cosmetic, but log it loudly. The pin is
		// already valid (window linked, vars stamped) — a leftover placeholder window
		// in the pin-session does not affect board derivation or unpin.
		slog.Warn("board: pin placeholder kill failed", "server", server, "pin", pinSession, "placeholder", placeholderID, "err", err)
	}
	return nil
}

// Unpin removes the window's board membership by killing the pin-session. Under
// the link-based model the window is a member of BOTH its home session and the
// pin-session, so tmux keeps the window alive as long as ANY link survives:
// killing the pin-session simply drops the pin link and the window remains in
// its home session at its EXISTING position (no move-back, no append, no index
// loss).
//
// Last-link recovery: if the pin link is the window's LAST link (its home
// session died while pinned, or it is a legacy move-based pin that lives only in
// the pin-session), a plain kill-session would DESTROY the window. This case is
// detected first (no live non-pin membership) and instead takes a recovery path
// chosen by the recorded `@rk_ses_pin_home`:
//   - `@rk_ses_pin_home` names a session that is STILL ALIVE (a legacy move-based pin
//     whose home outlived the move) → LINK the window back into that live home,
//     then kill the pin-session, so the window lands in its real home.
//   - `@rk_ses_pin_home` names a session that is GONE → rename the (single-window)
//     pin-session to that home name, recreating the dead home in place.
//   - `@rk_ses_pin_home` is empty/corrupt (or any of the above fails) → rename the
//     pin-session to a collision-guarded `recovered<id>` name.
//
// In every branch the membership options are cleared and the window resurfaces
// in the SESSIONS sidebar — a window is never left unrecoverable.
//
// Idempotent: a missing pin-session is a silent success.
func Unpin(ctx context.Context, server, windowID, board string) error {
	ctx, cancel := context.WithTimeout(ctx, TmuxTimeout)
	defer cancel()
	if !ValidWindowID(windowID) {
		return fmt.Errorf("invalid window id")
	}
	if !ValidBoardName(board) {
		return fmt.Errorf("invalid board name")
	}
	pinSession, ok := PinSessionName(windowID)
	if !ok {
		return fmt.Errorf("invalid window id")
	}

	// Idempotency: no pin-session → nothing to unpin.
	if _, err := tmuxExecRawServer(ctx, server, "has-session", "-t", ExactSessionTarget(pinSession)); err != nil {
		return nil
	}

	// Board-match guard: only unpin if the pin actually belongs to the requested
	// board. A mismatched `/api/boards/{name}/unpin` (stale or wrong board name)
	// must NOT silently unpin the window AND must not cause the handler to emit a
	// `board-changed` event referencing a board the window was never on. Treat a
	// mismatch as a no-op success — the window stays pinned to its real board, and
	// the handler's broadcast (which names the URL board) describes a state that
	// did not change, so suppressing the unpin keeps SSE consistent. An unreadable
	// @rk_ses_pin_board is a real error.
	curBoard, err := showSessionOption(ctx, server, pinSession, BoardOption)
	if err != nil {
		if pinSessionGone(ctx, server, pinSession) {
			return nil
		}
		return fmt.Errorf("read %s: %w", BoardOption, err)
	}
	if curBoard != board {
		return nil
	}

	home, err := showSessionOption(ctx, server, pinSession, HomeOption)
	if err != nil {
		if pinSessionGone(ctx, server, pinSession) {
			return nil
		}
		return fmt.Errorf("read %s: %w", HomeOption, err)
	}

	// Normal path: the window is still linked into a live non-pin (home) session,
	// so killing the pin-session drops only the pin link — tmux keeps the window
	// alive in home at its existing position (no move-back, no append). Detect a
	// surviving non-pin membership directly rather than trusting @rk_ses_pin_home: a
	// window could have been re-homed, and only an actual live link makes the
	// kill-session safe.
	if _, hasHome, herr := resolveHomeSession(ctx, server, windowID); herr != nil {
		if pinSessionGone(ctx, server, pinSession) {
			return nil
		}
		return fmt.Errorf("resolve home membership for %q: %w", windowID, herr)
	} else if hasHome {
		return killPinSessionIfPresent(ctx, server, pinSession)
	}

	// Last-link recovery: the pin link is the window's only link (home died while
	// pinned, or a legacy move-based pin that lives only in the pin-session). A
	// plain kill-session would DESTROY the window, so instead resurface it in the
	// SESSIONS sidebar without ever losing it.
	//
	// No recorded @rk_ses_pin_home. With stamp-before-link (see Pin) this should be
	// unreachable for pins created by this build — @rk_ses_pin_home is durably set before
	// the window is ever linked into the pin-session — but a legacy/corrupt
	// pin-session could still lack it. Rather than hard-failing and stranding the
	// window invisibly (it is filtered from SESSIONS as a `_rk-pin-*` name and,
	// once we strip membership, also from BOARDS), RECOVER it: rename the
	// pin-session to a deterministic `recovered<id>` name so the window resurfaces.
	// A window is never left unrecoverable.
	if home == "" {
		slog.Warn("board: unpin found pin-session with no @rk_ses_pin_home — recovering window into a renamed session",
			"server", server, "pin", pinSession)
		return recoverPinToRenamedSession(ctx, server, pinSession)
	}
	// The recorded home is still ALIVE (a live non-pin membership was ruled out
	// above, so the window is NOT currently in it — the hallmark of a legacy
	// move-based pin whose home outlived the move). Restore the window INTO that
	// live home by LINKING it there, then kill the pin-session: killing drops the
	// pin link but the fresh home link keeps the window alive, landing it in the
	// real home session (not a stray `recovered<id>` session). This is the
	// untested-until-now half of the legacy-pin story — the home-died variants
	// below recreate a dead home; this variant reunites the window with a live one.
	if _, err := tmuxExecRawServer(ctx, server, "has-session", "-t", ExactSessionTarget(home)); err == nil {
		if err := LinkWindowToSession(windowID, home, server); err != nil {
			// Linking into the live home failed — do not strand the window in the
			// invisible pin-session. Fall back to the deterministic recovered-name
			// rename so it still resurfaces under a visible session.
			slog.Warn("board: unpin could not link window into live @rk_ses_pin_home — recovering into a renamed session",
				"server", server, "pin", pinSession, "home", home, "err", err)
			return recoverPinToRenamedSession(ctx, server, pinSession)
		}
		return killPinSessionIfPresent(ctx, server, pinSession)
	}
	// The recorded home is gone (no live non-pin membership, and no live session by
	// the recorded name) — recreate it by renaming the (single-window) pin-session
	// to the home name. This preserves the window as the sole window of the
	// recreated home session with no placeholder, and atomically removes the
	// `_rk-pin-*` name. The home name is free (has-session above failed), so the
	// rename cannot collide.
	if err := RenameSession(pinSession, home, server); err != nil {
		// The home name raced into existence between the check above and here — fall
		// back to the collision-guarded recovered-name rename rather than erroring.
		slog.Warn("board: unpin recreate-home rename failed — recovering into a renamed session",
			"server", server, "pin", pinSession, "home", home, "err", err)
		return recoverPinToRenamedSession(ctx, server, pinSession)
	}
	clearMembershipOptions(ctx, server, home)
	return nil
}

// recoverPinToRenamedSession renames the single-window pin-session to a
// `recovered<id>` session so the window resurfaces in SESSIONS, then strips its
// board-membership options. If the base `recovered<id>` name is already taken by
// a stale prior recovery, a numeric suffix is appended (`recovered<id>-2`, `-3`,
// …) so the rename never fails and never strands the window in the invisible
// pin-session. Returns an error only if no free name is found within the bounded
// probe.
func recoverPinToRenamedSession(ctx context.Context, server, pinSession string) error {
	base := "recovered" + strings.TrimPrefix(pinSession, PinSessionPrefix)
	name := base
	for attempt := 2; ; attempt++ {
		if _, err := tmuxExecRawServer(ctx, server, "has-session", "-t", ExactSessionTarget(name)); err != nil {
			break // name is free
		}
		if attempt > 100 {
			return fmt.Errorf("recover window from pin %q: no free recovered-session name after %d attempts", pinSession, attempt)
		}
		name = fmt.Sprintf("%s-%d", base, attempt)
	}
	if err := RenameSession(pinSession, name, server); err != nil {
		return fmt.Errorf("recover window from pin %q into %q: %w", pinSession, name, err)
	}
	clearMembershipOptions(ctx, server, name)
	return nil
}

// clearMembershipOptions unsets the three board-membership session options on a
// recovered/recreated session so a future board derivation does not mistake it
// for a live pin. Best-effort: an unset failure on an already-absent option is
// benign (the session is no longer a `_rk-pin-*` name and so never enumerated as
// a pin).
func clearMembershipOptions(ctx context.Context, server, session string) {
	_, _ = tmuxExecRawServer(ctx, server, "set-option", "-u", "-t", ExactSessionTarget(session), BoardOption)
	_, _ = tmuxExecRawServer(ctx, server, "set-option", "-u", "-t", ExactSessionTarget(session), HomeOption)
	_, _ = tmuxExecRawServer(ctx, server, "set-option", "-u", "-t", ExactSessionTarget(session), BoardOrderOption)
}

// pinSessionGone reports whether the pin-session no longer exists. Unpin's
// idempotency probe and its later reads are not atomic: a concurrent Unpin of
// the same window (a UI click racing an API call) can kill the pin-session in
// between, which makes those reads fail. A pin-session that is gone by then
// means the other call already reached the desired end state, so the failure
// is success, not an error.
func pinSessionGone(ctx context.Context, server, pinSession string) bool {
	_, err := tmuxExecRawServer(ctx, server, "has-session", "-t", ExactSessionTarget(pinSession))
	return err != nil
}

// killPinSessionIfPresent kills the pin-session, treating an
// already-gone session ("can't find session" / "session not found") as success.
// This is the normal-path Unpin teardown: because the window is LINKED into both
// its pin-session and its home session, killing the pin-session drops only the
// pin link and tmux keeps the window alive in home (it destroys a window only
// when its LAST link dies). The has-session guard tolerates a pin-session that
// already vanished (e.g. a concurrent kill), so the kill is best-effort.
func killPinSessionIfPresent(ctx context.Context, server, pinSession string) error {
	if pinSessionGone(ctx, server, pinSession) {
		// Already gone — the desired end state.
		return nil
	}
	if err := KillSessionCtx(ctx, server, pinSession); err != nil && !pinSessionGone(ctx, server, pinSession) {
		return err
	}
	return nil
}

// Reorder updates the order key of an existing pin by rewriting only its
// pin-session's @rk_ses_pin_order var. Returns an error if the pin-session does
// not exist, is not on the named board, or newOrderKey is invalid.
func Reorder(ctx context.Context, server, windowID, board, newOrderKey string) error {
	ctx, cancel := context.WithTimeout(ctx, TmuxTimeout)
	defer cancel()
	if !ValidWindowID(windowID) {
		return fmt.Errorf("invalid window id")
	}
	if !ValidBoardName(board) {
		return fmt.Errorf("invalid board name")
	}
	if !ValidOrderKey(newOrderKey) {
		return fmt.Errorf("invalid order key")
	}
	pinSession, ok := PinSessionName(windowID)
	if !ok {
		return fmt.Errorf("invalid window id")
	}
	if _, err := tmuxExecRawServer(ctx, server, "has-session", "-t", ExactSessionTarget(pinSession)); err != nil {
		return fmt.Errorf("entry not found")
	}
	current, err := showSessionOption(ctx, server, pinSession, BoardOption)
	if err != nil {
		return err
	}
	if current != board {
		return fmt.Errorf("entry not found")
	}
	return setSessionOption(ctx, server, pinSession, BoardOrderOption, newOrderKey)
}

// ComputeOrderKey returns a key strictly between `before` and `after` in
// lexicographic order, using the lowercase a-z alphabet. Either or both
// neighbours may be empty: `before == ""` means prepend, `after == ""` means
// append.
//
// Invariants:
//   - The returned key satisfies before < key < after (lexicographic) when both
//     neighbours are non-empty; the comparison is one-sided otherwise.
//   - The key never renumbers existing entries; insertion is always between
//     the supplied neighbours.
//
// Algorithm: walk both keys in lockstep. Find the first depth at which a
// strictly-between letter exists. Otherwise descend by appending the prefix
// of `before` and an `m` suffix as a midpoint (extension).
func ComputeOrderKey(before, after string) (string, error) {
	// Validate neighbours: empty or pattern-conformant.
	if before != "" && !ValidOrderKey(before) {
		return "", fmt.Errorf("invalid before key")
	}
	if after != "" && !ValidOrderKey(after) {
		return "", fmt.Errorf("invalid after key")
	}
	if before != "" && after != "" && before >= after {
		return "", fmt.Errorf("before must be lexicographically less than after")
	}

	const minByte = byte('a')
	const maxByte = byte('z')

	// Special-case prepend / append based on the neighbour at depth 0.
	if before == "" {
		// Need a key < after. Try one letter less than after[0].
		if len(after) == 0 {
			return initialAppendKey, nil
		}
		first := after[0]
		if first > minByte {
			return string([]byte{first - 1}), nil
		}
		// after starts with 'a'. Any key starting with 'a' is either equal
		// to "a" or greater (because "a" is a prefix); shorter keys would
		// also need to be < "a" which is impossible in [a-z]+. The only
		// resolution is to renumber — which is forbidden — so we error.
		// Callers should pick "a" or higher for the first slot to avoid
		// running into this; nextAppendKey starts at "m" for that reason.
		return "", fmt.Errorf("cannot generate key strictly less than %q", after)
	}
	if after == "" {
		// Need a key > before. Try one letter more than before[0].
		first := before[0]
		if first < maxByte {
			// Greater first letter is unconditionally greater regardless of
			// before's tail, so a single letter suffices.
			return string([]byte{first + 1}), nil
		}
		// before starts with 'z' — descend, finding a key > before[1:].
		inner, err := ComputeOrderKey(before[1:], "")
		if err != nil {
			return "", err
		}
		// Returned key when stacked under 'z' must still preserve > before.
		// 'z' + inner > 'z' + before[1:] iff inner > before[1:], which the
		// recursive call guarantees.
		if len(before) >= 16 {
			return "", fmt.Errorf("order key length exceeded")
		}
		return "z" + inner, nil
	}

	// Both neighbours present. Walk the shared prefix.
	i := 0
	for i < len(before) && i < len(after) && before[i] == after[i] {
		i++
	}
	prefix := before[:i]

	var bChar byte
	if i < len(before) {
		bChar = before[i]
	} else {
		// `before` is a prefix of `after`. We need before < key < after, with
		// key starting with `prefix` and continuing differently. Drop into the
		// "append after `before`" branch with after[i:].
		// The new key starts with prefix; the next char must be a letter that
		// stays strictly less than after[i] (since after has more chars).
		// Equivalently, we need a key > "" but strictly less than after[i:].
		// after[i:] is non-empty here.
		afterTail := after[i:]
		// Recurse: need key in ("", afterTail). If afterTail[0] > 'a', use
		// afterTail[0]-1. Otherwise zero-pad with 'a'.
		inner, err := ComputeOrderKey("", afterTail)
		if err != nil {
			return "", err
		}
		if len(prefix)+len(inner) > 16 {
			return "", fmt.Errorf("order key length exceeded")
		}
		return prefix + inner, nil
	}

	var aChar byte
	if i < len(after) {
		aChar = after[i]
	} else {
		// `after` is a prefix of `before`. Cannot happen because before < after
		// implies after is not a prefix of before unless they're equal, which
		// the earlier check rejects.
		return "", fmt.Errorf("after is a prefix of before")
	}

	// Letters at depth i are bChar < aChar.
	if aChar-bChar > 1 {
		// At least one letter strictly between — pick the midpoint.
		mid := bChar + (aChar-bChar)/2
		if len(prefix)+1 > 16 {
			return "", fmt.Errorf("order key length exceeded")
		}
		return prefix + string([]byte{mid}), nil
	}

	// aChar == bChar+1: no letter fits at this depth. Strategy: extend `before`
	// with a key strictly greater than before[i+1:] (open-ended on the right).
	// The new key is prefix + bChar + extension; this is < prefix + aChar +
	// anything = `after`-prefix.
	tail := before[i+1:]
	inner, err := ComputeOrderKey(tail, "")
	if err != nil {
		return "", err
	}
	if len(prefix)+1+len(inner) > 16 {
		return "", fmt.Errorf("order key length exceeded")
	}
	return prefix + string([]byte{bChar}) + inner, nil
}
