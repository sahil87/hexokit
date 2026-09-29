package main

import (
	"context"
	"fmt"
	"net/url"
	"os"
	"strings"

	"rk/internal/config"
	"rk/internal/tmux"
)

// originRunOutputFn / originOriginalTMUXFn are package-level seams so
// resolveOrigin can be tested without a live tmux server (the
// roleRunOutputFn/roleOriginalTMUXFn idiom from role.go). The defaults
// delegate to the internal/tmux Run core (exec.CommandContext, argv slices —
// Constitution §I); OriginalTMUX is the captured pre-init $TMUX value.
var (
	originRunOutputFn    = func(ctx context.Context, args []string) ([]byte, error) { return tmux.RunOutput(ctx, args, tmux.RunOpts{}) }
	originOriginalTMUXFn = func() string { return tmux.OriginalTMUX }
)

// resolveOrigin returns the origin (e.g. "http://127.0.0.1:3001") of the
// run-kit deployment covering the CALLER, with explicit precedence:
//
//  1. Explicit env wins: RK_HOST or RK_PORT set (non-empty) in the caller's
//     environment resolves exactly as config.Load() sees it — a deliberate
//     operator override. No tmux subprocess is spawned on this rung.
//  2. Tmux option: inside a tmux pane ($TMUX captured at package init —
//     internal/tmux's init() strips it), read @rk_srv_origin from the pane's OWN
//     server via the $TMUX socket path. The value is validated (parseable
//     http/https URL with a non-empty host) before use; empty, unreadable, or
//     invalid values fall through.
//  3. Default: the config.Load() derivation (http://127.0.0.1:<portpolicy
//     default> without env) — unchanged fallback.
//
// The option is pane-writable same-user state, so rung 2's validation is what
// keeps a garbage/hostile value from becoming a request target (A-018).
func resolveOrigin(ctx context.Context) string {
	cfg := config.Load()
	fallback := fmt.Sprintf("http://%s:%d", cfg.Host, cfg.Port)

	// Rung 1: explicit env is a deliberate override (Constitution X — when a
	// fact is available both ways, derivation from the caller's env wins).
	if os.Getenv("RK_HOST") != "" || os.Getenv("RK_PORT") != "" {
		return fallback
	}

	// Rung 2: the covering deployment's stamp, read at request time — never
	// cached. tmuxSocketArgs derives the pane's own server socket from the
	// captured $TMUX; empty means "not in a pane" (or malformed), which falls
	// through with zero subprocess calls.
	if prefix := tmuxSocketArgs(originOriginalTMUXFn()); len(prefix) > 0 {
		ctx, cancel := context.WithTimeout(ctx, tmux.TmuxTimeout)
		defer cancel()
		out, err := originRunOutputFn(ctx, append(prefix, "show-option", "-sv", tmux.OriginOption))
		if err == nil {
			if origin := validOrigin(strings.TrimSpace(string(out))); origin != "" {
				return origin
			}
		}
	}

	return fallback
}

// validOrigin returns the normalized origin (scheme://host[:port]) when raw is
// a usable server origin — parseable URL, http/https scheme, non-empty host,
// and no path/query/fragment (callers concatenate paths onto the result, so a
// value carrying its own path is not an origin) — and "" otherwise (fall
// through).
func validOrigin(raw string) string {
	if raw == "" {
		return ""
	}
	u, err := url.Parse(raw)
	if err != nil {
		return ""
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return ""
	}
	if u.Host == "" {
		return ""
	}
	if u.Path != "" || u.RawQuery != "" || u.Fragment != "" {
		return ""
	}
	return u.Scheme + "://" + u.Host
}
