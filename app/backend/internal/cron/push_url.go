package cron

import (
	"context"
	"net/url"
	"strings"
)

// push_url.go — the notify deep-link: a same-origin path to the server's
// role:operator window with the Cron segment selected
// (/{server}/{N}?tab=cron). The fail-silent contract is absolute: an
// unresolvable operator window yields "", and the notify fires URL-less —
// the tick never errors, blocks, or retries over a missing deep link.

// cronPushTab is the terminal-route search-param value the deep-link selects.
const cronPushTab = "cron"

// PushURL builds the deep-link path from a resolved operator window id: the
// URL segment is the window id's numeric part (the tmux `@N` sans `@`), both
// segments path-escaped (the waitingPushURL shape). "" windowID ⇒ "".
func PushURL(server, windowID string) string {
	if windowID == "" {
		return ""
	}
	seg := strings.TrimPrefix(windowID, "@")
	return "/" + url.PathEscape(server) + "/" + url.PathEscape(seg) + "?tab=" + cronPushTab
}

// operatorPushURL resolves the server's role:operator carrier window via the
// tick's TmuxSeam (the same @rk_win_role radio semantics GatherFacts uses —
// no new tmux surface) and returns its deep-link; "" when no live operator
// window resolves or enumeration fails.
func operatorPushURL(ctx context.Context, server string, seam TmuxSeam) string {
	sessions, err := seam.ListSessions(ctx, server)
	if err != nil {
		return ""
	}
	for _, s := range sessions {
		wins, err := seam.ListWindows(ctx, s.Name, server)
		if err != nil {
			continue
		}
		for _, w := range wins {
			if w.Role == RoleOperator {
				return PushURL(server, w.WindowID)
			}
		}
	}
	return ""
}
