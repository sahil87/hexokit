package main

// rk tab web — the shell twins of the web verb routes: add appends a target
// to a tab's web-tab family (optionally showing it), rm/mv/select mutate the
// dense family, and ls enumerates it. Address forms come from
// internal/tabaddr; the family invariants (dense append, idempotent hit,
// _active arming) are internal/tmux's Web* ops.

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"
	"text/tabwriter"
	"time"

	"rk/internal/layoutspec"
	"rk/internal/present"
	"rk/internal/tabaddr"
	"rk/internal/tmux"

	"github.com/spf13/cobra"
)

// tabCmdTimeout bounds every tmux subprocess a tab verb spawns (Constitution
// §I: 5-10s for short-lived tmux helpers; the present.go precedent).
const tabCmdTimeout = 5 * time.Second

var (
	tabWebAddShowFlag bool
	tabWebLsJSONFlag  bool
	tabWebJSONFlag    bool
)

// tabWebReceipt is the --json success document of the four web mutations:
// the window, the affected slot (mv: the destination), add's resolved URL,
// and the post-mutation family in the `tab web ls --json` entry shape. Tabs
// is a pointer so a failed read-back omits the key (nil) while an emptied
// family still marshals as [].
type tabWebReceipt struct {
	Window string               `json:"window"`
	Index  int                  `json:"index"`
	URL    string               `json:"url,omitempty"`
	Tabs   *[]tabWebLsJSONEntry `json:"tabs,omitempty"`
}

// tabWebFamilyEntries maps a family read onto the `tab web ls --json` entry
// shape (index, url, root omitempty).
func tabWebFamilyEntries(fam tmux.WebTabFamily) []tabWebLsJSONEntry {
	tabs := make([]tabWebLsJSONEntry, 0, len(fam.Tabs))
	for i, u := range fam.Tabs {
		entry := tabWebLsJSONEntry{Index: i + 1, URL: u}
		if i < len(fam.Roots) {
			entry.Root = fam.Roots[i]
		}
		tabs = append(tabs, entry)
	}
	return tabs
}

// tabWebEmitReceipt prints a mutation's --json receipt: the post-mutation
// family is read back through presentReadFamilyFn; a failed read-back is a
// stderr note with tabs omitted, never an error (the mutation already
// happened).
func tabWebEmitReceipt(cmd *cobra.Command, ctx context.Context, windowID, server string, index int, url string) {
	sink := newSink(cmd)
	receipt := tabWebReceipt{Window: windowID, Index: index, URL: url}
	fam, err := presentReadFamilyFn(ctx, windowID, server)
	if err != nil {
		sink.Notef("web-tab family read-back failed (%v) — tabs omitted\n", err)
	} else {
		entries := tabWebFamilyEntries(fam)
		receipt.Tabs = &entries
	}
	sink.JSONResult(receipt)
}

// tabWebRejectShow is the --show guard for the mutations that do not take it
// (--show is persistent on the parent so the MCP drift guard resolves it on
// the family path; rm/select/mv reject it as usage).
func tabWebRejectShow(cmd *cobra.Command) error {
	if cmd.Flags().Changed("show") {
		return usageError(fmt.Errorf("--show only applies to tab web add"))
	}
	return nil
}

var tabWebCmd = &cobra.Command{
	Use:   "web",
	Short: "Add, remove, move, select, or list a tab's web tabs",
	Long: "Manage a tab's web-tab family (@rk_win_web_<n>): 'add' attaches a file,\n" +
		"directory, port, or URL target (the rk present resolution) to the next\n" +
		"slot; 'rm', 'select', and 'mv' address slots as @N/web/<n>, web/<n>, or\n" +
		"a bare <n> on the caller's own tab; 'ls' lists the slots.\n\n" +
		"See 'rk tab web <subcommand> --help' for details.",
}

var tabWebAddCmd = &cobra.Command{
	Use:   "add [@N] <target> [--show]",
	Short: "Attach a file, directory, port, or URL to a tab's web-tab strip",
	Long: "Attach web content to a tab's web-tab family. The target resolves exactly\n" +
		"like 'rk present' (see 'rk present --help'): a file or directory is served\n" +
		"live, :PORT and localhost URLs attach via the relative /proxy/<port>/ form,\n" +
		"and any other URL attaches verbatim. Port targets get a best-effort\n" +
		"reachability probe first.\n\n" +
		"Stdout carries the attached slot's address (@N/web/<n>; an idempotent\n" +
		"re-add prints the existing slot); the resolved URL echoes to stderr.\n" +
		"--show additionally ensures the web surface is in the tab's layout\n" +
		"(growing it through the ordinary growth table; a full 3-tile layout\n" +
		"without web yields its last slot) and selects the added tab. A full strip\n" +
		"(8 tabs) is an operational failure — rm one first.",
	Args:         cobra.RangeArgs(1, 2),
	SilenceUsage: true,
	RunE:         runTabWebAdd,
}

var tabWebRmCmd = &cobra.Command{
	Use:   "rm [@N/]web/<n>",
	Short: "Remove a web tab from a tab's strip",
	Long: "Remove web tab <n> from the addressed tab's family: the slots above it\n" +
		"shift down (URL and serve root move together) and the active pointer\n" +
		"repoints. The address is @N/web/<n>, web/<n>, or a bare <n> on the\n" +
		"caller's own tab. Prints nothing on success; an out-of-range <n> is an\n" +
		"operational failure naming the family's length.",
	Args:         cobra.ExactArgs(1),
	SilenceUsage: true,
	RunE: func(cmd *cobra.Command, args []string) error {
		if err := tabWebRejectShow(cmd); err != nil {
			return err
		}
		return runTabWebRm(cmd, args)
	},
}

var tabWebSelectCmd = &cobra.Command{
	Use:   "select [@N/]web/<n>",
	Short: "Select the active web tab of a tab's strip",
	Long: "Select web tab <n> as the tab's active web tab (the tile the web surface\n" +
		"shows). The address is @N/web/<n>, web/<n>, or a bare <n> on the caller's\n" +
		"own tab. Prints nothing on success; an out-of-range <n> is an operational\n" +
		"failure naming the family's length.",
	Args:         cobra.ExactArgs(1),
	SilenceUsage: true,
	RunE: func(cmd *cobra.Command, args []string) error {
		if err := tabWebRejectShow(cmd); err != nil {
			return err
		}
		return runTabWebSelect(cmd, args)
	},
}

var tabWebMvCmd = &cobra.Command{
	Use:   "mv [@N/]web/<n> <m>",
	Short: "Move a web tab to a new slot position",
	Long: "Move web tab <n> to slot position <m> in the addressed tab's family: the\n" +
		"tab leaves slot <n> and inserts at <m>, URL and serve root moving as a\n" +
		"pair, and the active pointer repoints to follow tab identity. The address\n" +
		"is @N/web/<n>, web/<n>, or a bare <n> on the caller's own tab; <m> is a\n" +
		"bare 1-based slot. Prints the resulting address on stdout; an\n" +
		"out-of-range <n> or <m> is an operational failure naming the family's\n" +
		"length.",
	Args:         cobra.ExactArgs(2),
	SilenceUsage: true,
	RunE: func(cmd *cobra.Command, args []string) error {
		if err := tabWebRejectShow(cmd); err != nil {
			return err
		}
		return runTabWebMv(cmd, args)
	},
}

var tabWebLsCmd = &cobra.Command{
	Use:   "ls [@N] [--json]",
	Short: "List a tab's web tabs",
	Long: "List a tab's web-tab slots, one row per slot: index, an '*' on the active\n" +
		"slot, and the URL. Zero tabs prints nothing and exits 0. --json prints\n" +
		"{\"windowId\":\"@N\",\"active\":<n>,\"tabs\":[{\"index\":1,\"url\":\"…\",\"root\":\"…\"}]}\n" +
		"inside the standard {\"ok\":true,\"result\":…} envelope (root omitted when\n" +
		"empty; tabs is [] never null).",
	Args:         cobra.MaximumNArgs(1),
	SilenceUsage: true,
	RunE:         runTabWebLs,
}

func init() {
	// --show and --json are persistent on the family: the MCP policy row's
	// drift guard resolves flags on the row's path (the parent), and the verbs
	// that do not take --show (rm/select/mv) reject it as usage at run time.
	tabWebCmd.PersistentFlags().BoolVar(&tabWebAddShowFlag, "show", false,
		"Ensure web is in the tab's layout after adding, then select the tab (add only)")
	tabWebCmd.PersistentFlags().BoolVar(&tabWebJSONFlag, "json", false,
		"Emit the machine-readable envelope (exactly one JSON document on stdout)")
	tabWebLsCmd.Flags().BoolVar(&tabWebLsJSONFlag, "json", false,
		"Print the family as a JSON object inside the {\"ok\",\"result\"} envelope")
	tabWebCmd.AddCommand(tabWebAddCmd)
	tabWebCmd.AddCommand(tabWebRmCmd)
	tabWebCmd.AddCommand(tabWebSelectCmd)
	tabWebCmd.AddCommand(tabWebMvCmd)
	tabWebCmd.AddCommand(tabWebLsCmd)
	// Arg-count violations are usage-class (exit 2) — wrapped at the add site
	// (tab.go's init runs before this file's).
	for _, c := range tabWebCmd.Commands() {
		if c.Args != nil {
			c.Args = usageArgs(c.Args)
		}
	}
}

// tabContext returns the command's context; direct RunE invocations (the
// package's test idiom) leave it nil, so fall back explicitly (the code.go
// codeContext pattern).
func tabContext(cmd *cobra.Command) context.Context {
	if ctx := cmd.Context(); ctx != nil {
		return ctx
	}
	return context.Background()
}

// resolveTabAddr parses the optional address argument ("" = own tab, @N[/...],
// or =session:window) and resolves it to (windowID, server) through the
// shared own-tab resolver. serverFlag is the -L/--server value ("" when the
// verb has no such flag). Every address-taking verb — the rk tab family and
// rk code exec|commands --tab — enters here so the accepted grammar cannot
// drift between them.
func resolveTabAddr(ctx context.Context, arg, serverFlag string) (tabaddr.Addr, string, string, error) {
	if strings.HasPrefix(arg, "=") {
		// =session:window targets are resolved by resolveTabWindow directly —
		// the tabaddr grammar is the tab-relative part only.
		windowID, server, err := resolveTabWindow(ctx, tabaddr.Addr{WindowID: arg}, serverFlag)
		return tabaddr.Addr{WindowID: arg}, windowID, server, err
	}
	addr, err := tabaddr.Parse(arg)
	if err != nil {
		return addr, "", "", usageError(err)
	}
	windowID, server, err := resolveTabWindow(ctx, addr, serverFlag)
	return addr, windowID, server, err
}

// tabSetWindowOptionsFn is the @rk_win_* write seam for the whole rk tab
// family (tab layout, tab code set, and webAddShow's --show arm); webSelectFn
// is the select seam behind --show. Package-level so tests drive the write
// paths without a live server (the present*Fn pattern); the defaults delegate
// to internal/tmux.
var (
	tabSetWindowOptionsFn = func(ctx context.Context, windowID, server string, ops []tmux.WindowOptionOp) error {
		return tmux.SetWindowOptions(ctx, windowID, server, ops)
	}
	webSelectFn = func(ctx context.Context, windowID, server string, n int) error {
		return tmux.WebSelect(ctx, windowID, server, n)
	}
)

// webAddShow is the one code path behind `rk tab web add` and `rk present`:
// add the target to windowID's web-tab family via WebAdd and, under show,
// ensure web is in the window's layout as a BARE leaf — a foreign @N/web tile
// does not count (it tiles another window's surface) — growing through the
// ordinary table (a full 3-tile layout without web replaces its LAST slot —
// slot A is never touched — so a show never fails on a full layout), and
// select the added tab.
// Returns the slot index and the resolved URL of that slot.
func webAddShow(ctx context.Context, windowID, server string, target present.Target, show bool) (index int, url string, err error) {
	fam, err := presentReadFamilyFn(ctx, windowID, server)
	if err != nil {
		return 0, "", fmt.Errorf("read web-tab family for %s: %w", windowID, err)
	}
	root := ""
	if target.NeedsRoot() {
		root = target.Root
	}
	index, _, err = presentWebAddFn(ctx, windowID, server, target.URL(server, root, presentNowFn), root)
	if err != nil {
		if errors.Is(err, tmux.ErrWebTabsFull) {
			return 0, "", fmt.Errorf("web tabs full (%d) on %s — rm one first", tmux.MaxWebTabs, windowID)
		}
		return 0, "", fmt.Errorf("attach to window %s: %w", windowID, err)
	}
	url = target.URL(server, root, presentNowFn)

	if !show {
		return index, url, nil
	}

	// The family read above carries the raw layout; an unset or unparseable
	// value reads as Default (degrade, never error — the frontend's
	// effectiveLayout fallback), replaced on write.
	layout, lerr := layoutspec.Parse(fam.Layout)
	if lerr != nil {
		layout = layoutspec.Default()
	}
	if !layout.HasBare("web") {
		next, nerr := layoutspec.Add(layout, "web")
		if nerr != nil {
			return 0, "", fmt.Errorf("show web on window %s: %w", windowID, nerr)
		}
		v := next.String()
		if err := tabSetWindowOptionsFn(ctx, windowID, server, []tmux.WindowOptionOp{{Key: tmux.LayoutOption, Value: &v}}); err != nil {
			return 0, "", fmt.Errorf("write layout for window %s: %w", windowID, err)
		}
	}
	if err := webSelectFn(ctx, windowID, server, index); err != nil {
		return 0, "", fmt.Errorf("select web tab %d on %s: %w", index, windowID, err)
	}
	return index, url, nil
}

func runTabWebAdd(cmd *cobra.Command, args []string) error {
	addrArg := ""
	targetArg := args[0]
	if len(args) == 2 {
		addrArg, targetArg = args[0], args[1]
	}
	ctx := tabContext(cmd)
	_, windowID, server, err := resolveTabAddr(ctx, addrArg, tabServerFlag)
	if err != nil {
		return err
	}

	cwd, err := os.Getwd()
	if err != nil {
		return fmt.Errorf("resolve working directory: %w", err)
	}
	target, err := present.ParseTargetWithOrigins(targetArg, cwd, []string{resolveOrigin(ctx)})
	if err != nil {
		return err
	}

	ctx, cancel := context.WithTimeout(ctx, tabCmdTimeout)
	defer cancel()

	if target.NeedsProbe() {
		if err := presentProbeFn(ctx, target.Port); err != nil {
			return err
		}
	}

	index, url, err := webAddShow(ctx, windowID, server, target, tabWebAddShowFlag)
	if err != nil {
		return err
	}
	sink := newSink(cmd)
	sink.Notef("url: %s\n", url)
	if tabWebJSONFlag {
		tabWebEmitReceipt(cmd, ctx, windowID, server, index, url)
	} else {
		sink.Dataf("%s/web/%d\n", windowID, index)
	}
	tabWakeFn(ctx, server)
	return nil
}

// resolveWebSlot parses the rm/select address, requiring an <n> segment, and
// resolves the tab. A slot-less address is a usage error.
func resolveWebSlot(ctx context.Context, arg string) (windowID, server string, n int, err error) {
	addr, err := tabaddr.Parse(arg)
	if err != nil {
		return "", "", 0, usageError(err)
	}
	if addr.Index == 0 {
		return "", "", 0, usageError(fmt.Errorf("web tab address %q needs an <n> segment (@N/web/<n>, web/<n>, or <n>)", arg))
	}
	windowID, server, err = resolveTabWindow(ctx, addr, tabServerFlag)
	if err != nil {
		return "", "", 0, err
	}
	return windowID, server, addr.Index, nil
}

// webRangeError renders ErrWebTabRange with the slot and the family's length.
func webRangeError(ctx context.Context, windowID, server string, n int, err error) error {
	if !errors.Is(err, tmux.ErrWebTabRange) {
		return err
	}
	fam, rerr := presentReadFamilyFn(ctx, windowID, server)
	if rerr != nil {
		return err
	}
	return fmt.Errorf("no web tab %d on %s (family has %d)", n, windowID, len(fam.Tabs))
}

func runTabWebRm(cmd *cobra.Command, args []string) error {
	ctx := tabContext(cmd)
	windowID, server, n, err := resolveWebSlot(ctx, args[0])
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(ctx, tabCmdTimeout)
	defer cancel()
	if err := tmux.WebRemove(ctx, windowID, server, n); err != nil {
		return webRangeError(ctx, windowID, server, n, err)
	}
	if tabWebJSONFlag {
		tabWebEmitReceipt(cmd, ctx, windowID, server, n, "")
	}
	tabWakeFn(ctx, server)
	return nil
}

func runTabWebSelect(cmd *cobra.Command, args []string) error {
	ctx := tabContext(cmd)
	windowID, server, n, err := resolveWebSlot(ctx, args[0])
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(ctx, tabCmdTimeout)
	defer cancel()
	if err := tmux.WebSelect(ctx, windowID, server, n); err != nil {
		return webRangeError(ctx, windowID, server, n, err)
	}
	if tabWebJSONFlag {
		tabWebEmitReceipt(cmd, ctx, windowID, server, n, "")
	}
	tabWakeFn(ctx, server)
	return nil
}

func runTabWebMv(cmd *cobra.Command, args []string) error {
	ctx := tabContext(cmd)
	windowID, server, n, err := resolveWebSlot(ctx, args[0])
	if err != nil {
		return err
	}
	to, err := strconv.Atoi(args[1])
	if err != nil {
		return usageError(fmt.Errorf("mv destination %q must be a slot index (1..%d)", args[1], tmux.MaxWebTabs))
	}
	ctx, cancel := context.WithTimeout(ctx, tabCmdTimeout)
	defer cancel()
	if err := tmux.WebMove(ctx, windowID, server, n, to); err != nil {
		return webMoveRangeError(ctx, windowID, server, n, to, err)
	}
	sink := newSink(cmd)
	if tabWebJSONFlag {
		tabWebEmitReceipt(cmd, ctx, windowID, server, to, "")
	} else {
		sink.Dataf("%s/web/%d\n", windowID, to)
	}
	tabWakeFn(ctx, server)
	return nil
}

// webMoveRangeError renders ErrWebTabRange for mv, naming whichever of (n, to)
// actually falls outside the family (n stays if valid) — the same shape
// webRangeError produces for rm/select.
func webMoveRangeError(ctx context.Context, windowID, server string, n, to int, err error) error {
	if !errors.Is(err, tmux.ErrWebTabRange) {
		return err
	}
	fam, rerr := presentReadFamilyFn(ctx, windowID, server)
	if rerr != nil {
		return err
	}
	bad := to
	if n < 1 || n > len(fam.Tabs) {
		bad = n
	}
	return fmt.Errorf("no web tab %d on %s (family has %d)", bad, windowID, len(fam.Tabs))
}

// tabWebLsJSONEntry is one slot in the --json family dump; root is omitted
// when empty.
type tabWebLsJSONEntry struct {
	Index int    `json:"index"`
	URL   string `json:"url"`
	Root  string `json:"root,omitempty"`
}

func runTabWebLs(cmd *cobra.Command, args []string) error {
	addrArg := ""
	if len(args) == 1 {
		addrArg = args[0]
	}
	ctx := tabContext(cmd)
	_, windowID, server, err := resolveTabAddr(ctx, addrArg, tabServerFlag)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(ctx, tabCmdTimeout)
	defer cancel()
	fam, err := presentReadFamilyFn(ctx, windowID, server)
	if err != nil {
		return fmt.Errorf("read web-tab family for %s: %w", windowID, err)
	}

	sink := newSink(cmd)
	if tabWebLsJSONFlag {
		doc := struct {
			WindowID string              `json:"windowId"`
			Active   int                 `json:"active"`
			Tabs     []tabWebLsJSONEntry `json:"tabs"`
		}{WindowID: windowID, Active: fam.Active, Tabs: tabWebFamilyEntries(fam)}
		if err := sink.Envelope(doc, nil); err != nil {
			return fmt.Errorf("encoding web-tab family: %w", err)
		}
		return nil
	}

	if len(fam.Tabs) == 0 {
		return nil // zero tabs print nothing (still exit 0)
	}
	var buf strings.Builder
	tw := tabwriter.NewWriter(&buf, 0, 0, 2, ' ', 0)
	for i, u := range fam.Tabs {
		marker := ""
		if i+1 == fam.Active {
			marker = "*"
		}
		fmt.Fprintf(tw, "%d\t%s\t%s\n", i+1, marker, u)
	}
	if err := tw.Flush(); err != nil {
		return err
	}
	sink.Dataf("%s", buf.String())
	return nil
}
