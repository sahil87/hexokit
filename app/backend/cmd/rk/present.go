package main

import (
	"context"
	"fmt"
	"os"
	"strings"
	"time"

	"rk/internal/present"
	"rk/internal/tmux"
	"rk/internal/validate"

	"github.com/spf13/cobra"
)

// rk present <target> — sugar over the rk tab family: the default arm is
// exactly `rk tab web add <target> --show` on the caller's own tab (attach
// the target, ensure web is in the tab's layout, select the tab), and
// --window[=name] is `rk tab new --layout web [--name]` followed by
// the same add on the new window. Both arms ride webAddShow — one code path,
// no duplicated attach logic (docs/specs/ui-state.md § Web Tabs).
//
// Stdout carries exactly the resolved URL (relative for /present, /proxy, and
// same-origin paths; absolute for external URLs) — present's data contract;
// `rk tab web add` prints the address instead. Exit codes follow the toolkit
// convention (Principle 4): 0 success, 1 operational failure (not in tmux,
// missing file, unreachable port, tmux failure), 2 usage error (no target,
// unknown flag). Only the --notify send deviates — fail-silent per rk
// notify's documented contract. Diagnostics go to stderr.

// presentCmdTimeout bounds every tmux subprocess the command spawns
// (Constitution §I: 5-10s for short-lived tmux helpers).
const presentCmdTimeout = 5 * time.Second

var (
	presentWindowFlag string
	presentNotifyFlag string
)

var presentCmd = &cobra.Command{
	Use:   "present <target> [--window[=name]] [--notify[=msg]]",
	Short: "Show a file, directory, port, or URL to the user as a web tile",
	Long: "Attach web content to the user's view. Alias of\n" +
		"'rk tab web add <target> --show' on the caller's own tab (plus\n" +
		"--window = 'rk tab new --layout web' then the add, and\n" +
		"--notify): the target attaches to the tab's web-tab strip, the web\n" +
		"tile is ensured in the tab's layout, and the tab is selected.\n\n" +
		"The target resolves to one of:\n" +
		"  ./mock.html          a file — served live, attached to this window\n" +
		"  ./dist/              a directory — served live (index.html default)\n" +
		"  :5173                a local port already serving — attached via /proxy/5173/\n" +
		"  http://localhost:N/… same, rewritten to the relative /proxy/N/… form\n" +
		"  $(rk url)/path        a URL on the run-kit server's own origin — attached as /path\n" +
		"  https://…            an external URL — attached verbatim\n\n" +
		"Stdout carries exactly the resolved URL (relative for /present, /proxy,\n" +
		"and same-origin /path targets; absolute for external URLs). --window spawns a\n" +
		"standalone iframe window instead; --notify sends a Web Push after\n" +
		"attaching (fail-silent).",
	Args: cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		return runPresent(cmd, args[0])
	},
}

// presentFlagAuto is the NoOptDefVal sentinel for --window/--notify: cobra
// only honors "flag without a value" when NoOptDefVal is non-empty, so a bare
// `--window` parses to this sentinel (derive the default) while `--window=x`
// carries x. The value is impossible to type as a real name/message.
const presentFlagAuto = "\x00auto"

func init() {
	// NoOptDefVal sentinel + Changed() distinguishes a bare --window/--notify
	// (use the derived default) from an absent flag and from --flag=value.
	presentCmd.Flags().StringVar(&presentWindowFlag, "window", "",
		"Spawn a standalone iframe window instead of attaching to this window (optional name; defaults from the target)")
	presentCmd.Flags().Lookup("window").NoOptDefVal = presentFlagAuto
	presentCmd.Flags().StringVar(&presentNotifyFlag, "notify", "",
		"Send a Web Push after attaching (optional message; defaults to \"presenting <basename>\")")
	presentCmd.Flags().Lookup("notify").NoOptDefVal = presentFlagAuto
}

// present*Fn are package-level seams so runPresent can be tested without a
// live tmux server or push endpoint (the role.go pattern); the defaults
// delegate to internal/tmux / internal/present / the rk notify send path.
// webAddShow and resolveTabNewSession ride these, so the seams also drive the
// rk tab verbs that share the code path.
var (
	presentWebAddFn = func(ctx context.Context, windowID, server, url, root string) (int, bool, error) {
		return tmux.WebAdd(ctx, windowID, server, url, root)
	}
	presentReadFamilyFn = func(ctx context.Context, windowID, server string) (tmux.WebTabFamily, error) {
		return tmux.ReadWebTabFamily(ctx, windowID, server)
	}
	presentProbeFn  = func(ctx context.Context, port int) error { return present.ProbePort(ctx, port) }
	presentNotifyFn = sendNotify
	presentNowFn    = func() int64 { return time.Now().Unix() }
)

// runPresent is the testable core: parse → probe → webAddShow (own tab, or a
// fresh web-tile window) → print → optionally notify. Every tmux call runs
// under one bounded context.
func runPresent(cmd *cobra.Command, arg string) error {
	cwd, err := os.Getwd()
	if err != nil {
		return fmt.Errorf("resolve working directory: %w", err)
	}

	parent := cmd.Context()
	if parent == nil {
		parent = context.Background()
	}
	ctx, cancel := context.WithTimeout(parent, presentCmdTimeout)
	defer cancel()
	target, err := present.ParseTargetWithOrigins(arg, cwd, []string{resolveOrigin(ctx)})
	if err != nil {
		return err
	}

	// Best-effort reachability probe for port/local-URL targets only.
	if target.NeedsProbe() {
		if err := presentProbeFn(ctx, target.Port); err != nil {
			return err
		}
	}

	var url, server string
	if cmd.Flags().Changed("window") {
		url, server, err = presentViaNewWindow(ctx, cmd, target)
	} else {
		url, server, err = presentAttach(ctx, target)
	}
	if err != nil {
		return err
	}

	sink := newSink(cmd)
	sink.Dataf("%s\n", url)
	tabWakeFn(ctx, server)

	// --notify is fail-silent by contract (rk notify): after a successful
	// attach, send and swallow any failure.
	if cmd.Flags().Changed("notify") {
		msg := presentNotifyFlag
		if msg == presentFlagAuto {
			msg = "presenting " + target.Name
		}
		presentNotifyFn(ctx, "", msg)
	}
	return nil
}

// presentAttach implements the default arm: `rk tab web add <target> --show`
// on the caller's OWN window — WebAdd lands the target in the web-tab family
// (dense append, idempotent hit, _active arming — its own invariants), the
// show arm ensures web is in the window's layout (a full 3-tile layout
// without web yields its last slot) and selects the slot. The window resolves
// through the shared own-tab resolver (owntab.go).
func presentAttach(ctx context.Context, target present.Target) (url, server string, err error) {
	windowID, server, err := ownWindowID(ctx)
	if err != nil {
		return "", "", err
	}
	_, url, err = webAddShow(ctx, windowID, server, target, true)
	return url, server, err
}

// presentViaNewWindow implements the --window arm: `rk tab new --layout
// web [--name]` (session resolution via the shared resolveTabNewSession)
// followed by the same add on the new window's empty family — WebAdd arms
// _active=1 and stores the slot's root; no --show needed, the web layout
// already shows the tile. The content-keyed /present/ URL carries no window
// id (the (server, roothash) form), so the add composes it once from the
// target and the add lands on the new window id creation returns (never a
// session:name re-resolution — window names are not unique).
func presentViaNewWindow(ctx context.Context, cmd *cobra.Command, target present.Target) (url, server string, err error) {
	name := presentWindowFlag
	if name == presentFlagAuto {
		name = presentWindowName(target)
	} else if errMsg := validate.ValidateNewName(name, "Window name"); errMsg != "" {
		return "", "", fmt.Errorf("--window name: %s", errMsg)
	}

	cwd, err := os.Getwd()
	if err != nil {
		return "", "", fmt.Errorf("resolve working directory: %w", err)
	}
	session, server, _, err := resolveTabNewSession(ctx, "", cwd)
	if err != nil {
		return "", "", err
	}

	// The tree form of "the web tile alone" — writers never emit a preset
	// string (the legacy single:web parses to the same leaf permanently).
	layout := "web"
	id, err := tabCreateWindowIDFn(session, name, "", server,
		[]tmux.WindowOptionOp{{Key: tmux.LayoutOption, Value: &layout}})
	if err != nil {
		return "", "", fmt.Errorf("create window: %w", err)
	}
	root := ""
	if target.NeedsRoot() {
		root = target.Root
	}
	_, _, err = presentWebAddFn(ctx, id, server, target.URL(server, root, presentNowFn), root)
	if err != nil {
		return "", "", fmt.Errorf("attach window %s: %w", id, err)
	}
	return target.URL(server, root, presentNowFn), server, nil
}

// presentWindowName derives the default standalone-window name from the
// target: basename (or host / port-<port>), with colons, periods, and spaces
// replaced by "-" (the port-<port> precedent — ValidateNewName forbids them).
// An unusable remainder falls back to "present".
func presentWindowName(target present.Target) string {
	name := strings.Map(func(r rune) rune {
		switch r {
		case ':', '.', ' ':
			return '-'
		}
		return r
	}, target.Name)
	if validate.ValidateNewName(name, "Window name") != "" {
		return "present"
	}
	return name
}
