package main

// rk tab layout — read or mutate a tab's @rk_win_layout. The verbs are
// internal/layoutspec's pure port of the frontend tree mutations, so agent
// and human go through one add/close/promote/cycle model. An unset or
// unparseable stored value reads as layoutspec.Default() (the bare tty leaf —
// the frontend's effectiveLayout fallback) and is REPLACED on write, never an
// error (Constitution II degrade rule).

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"rk/internal/layoutspec"
	"rk/internal/tmux"

	"github.com/spf13/cobra"
)

var (
	tabLayoutAddFlag     string
	tabLayoutRmFlag      string
	tabLayoutPromoteFlag string
	tabLayoutCycleFlag   bool
	tabLayoutJSONFlag    bool
)

// tabLayoutReceipt is the --json success document, on the read and every
// mutating form alike: the window id and the resulting layout value.
type tabLayoutReceipt struct {
	Window string `json:"window"`
	Layout string `json:"layout"`
}

var tabLayoutCmd = &cobra.Command{
	Use:   "layout [@N] [L | --add S | --rm S | --promote S | --cycle]",
	Short: "Read or mutate a tab's surface layout",
	Long: "Read or mutate a tab's @rk_win_layout — a canonical split tree\n" +
		"(e.g. h(tty,v(code,web)): h lays children left→right, v top→bottom,\n" +
		"1–3 tiles). Legacy <shape>:<surface,…> preset strings still parse and\n" +
		"rewrite to the tree form.\n\n" +
		"With a positional value the layout is SET (either grammar, validated;\n" +
		"malformed is a usage error). The flag forms mutate the current value\n" +
		"through the shared tree verbs: --add splits the last tile (reading\n" +
		"order) along its longer axis, --rm removes a tile (its neighbours\n" +
		"absorb the space, the structure is kept), --promote moves a tile to\n" +
		"slot A (the template's main tile), --cycle walks the tile count's\n" +
		"templates. Exactly one form may be given. With neither, the effective\n" +
		"layout prints and nothing is written.\n\n" +
		"An unset or unparseable stored value reads as tty. Every form prints\n" +
		"the tree form of the resulting layout on stdout.",
	Args:         cobra.MaximumNArgs(2),
	SilenceUsage: true,
	RunE:         runTabLayout,
}

func init() {
	tabLayoutCmd.Flags().StringVar(&tabLayoutAddFlag, "add", "",
		"Add a surface (splits the last tile along its longer axis)")
	tabLayoutCmd.Flags().StringVar(&tabLayoutRmFlag, "rm", "",
		"Remove a surface from the layout (its neighbours absorb the space)")
	tabLayoutCmd.Flags().StringVar(&tabLayoutPromoteFlag, "promote", "",
		"Move a surface to slot A")
	tabLayoutCmd.Flags().BoolVar(&tabLayoutCycleFlag, "cycle", false,
		"Cycle to the next template for the tile count")
	tabLayoutCmd.Flags().BoolVar(&tabLayoutJSONFlag, "json", false,
		"Emit the machine-readable envelope (exactly one JSON document on stdout)")
	tabLayoutCmd.MarkFlagsMutuallyExclusive("add", "rm", "promote", "cycle")
}

// layoutSentinelError maps a layoutspec sentinel to its exit class:
// ErrUnknownSurface is user input (usage, exit 2); the rest are operational
// (exit 1).
func layoutSentinelError(err error) error {
	switch {
	case errors.Is(err, layoutspec.ErrUnknownSurface):
		return usageError(err)
	default:
		return err
	}
}

func runTabLayout(cmd *cobra.Command, args []string) error {
	addrArg := ""
	value := ""
	switch len(args) {
	case 1:
		// One bare argument is the layout value to set (layoutspec decides);
		// a leading-@ or leading-= argument is the address, read-only form.
		if strings.HasPrefix(args[0], "@") || strings.HasPrefix(args[0], "=") {
			addrArg = args[0]
		} else {
			value = args[0]
		}
	case 2:
		addrArg, value = args[0], args[1]
	}

	mutating := value != "" || tabLayoutAddFlag != "" || tabLayoutRmFlag != "" ||
		tabLayoutPromoteFlag != "" || tabLayoutCycleFlag
	if value != "" && (tabLayoutAddFlag != "" || tabLayoutRmFlag != "" ||
		tabLayoutPromoteFlag != "" || tabLayoutCycleFlag) {
		return usageError(fmt.Errorf("give exactly one of a positional layout, --add, --rm, --promote, or --cycle"))
	}

	ctx := tabContext(cmd)
	_, windowID, server, err := resolveTabAddr(ctx, addrArg, tabServerFlag)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(ctx, tabCmdTimeout)
	defer cancel()
	sink := newSink(cmd)

	if value != "" {
		parsed, err := layoutspec.Parse(value)
		if err != nil {
			return usageError(err)
		}
		// Live-in-one-place check: a set introducing a foreign leaf another
		// window already holds is refused (borrow moves a held surface; a
		// plain write never steals it). Only a foreign leaf can conflict, so
		// the server-wide window enumeration is gated on that.
		if parsed.HasForeign() {
			windows, werr := tabServerWindows(ctx, server)
			if werr != nil {
				return werr
			}
			if cerr := tmux.CheckLiveInOnePlace(parsed, windowID, windows); cerr != nil {
				var held *tmux.LeafHeldError
				if errors.As(cerr, &held) {
					return cerr
				}
				return usageError(cerr)
			}
		}
		v := parsed.String()
		if err := tabSetWindowOptionsFn(ctx, windowID, server, []tmux.WindowOptionOp{{Key: tmux.LayoutOption, Value: &v}}); err != nil {
			return err
		}
		tabLayoutReport(sink, windowID, v)
		tabWakeFn(ctx, server)
		return nil
	}

	raw, err := tmux.GetWindowOption(ctx, windowID, server, tmux.LayoutOption)
	if err != nil {
		return err
	}
	layout, lerr := layoutspec.Parse(raw)
	if lerr != nil {
		if raw != "" {
			sink.Notef("replacing unparseable @rk_win_layout %q with %s\n", raw, layoutspec.Default())
		}
		layout = layoutspec.Default()
	}

	if !mutating {
		tabLayoutReport(sink, windowID, layout.String())
		return nil
	}

	var next layoutspec.Node
	switch {
	case tabLayoutAddFlag != "":
		next, err = layoutspec.Add(layout, tabLayoutAddFlag)
	case tabLayoutRmFlag != "":
		next, err = layoutspec.Close(layout, tabLayoutRmFlag)
	case tabLayoutPromoteFlag != "":
		if !layout.Has(tabLayoutPromoteFlag) {
			if !layoutspec.IsSurface(tabLayoutPromoteFlag) {
				err = fmt.Errorf("%w: %q", layoutspec.ErrUnknownSurface, tabLayoutPromoteFlag)
			} else {
				err = fmt.Errorf("%w: %q", layoutspec.ErrSurfaceAbsent, tabLayoutPromoteFlag)
			}
		} else {
			next = layoutspec.Promote(layout, tabLayoutPromoteFlag)
		}
	case tabLayoutCycleFlag:
		next = layoutspec.Cycle(layout)
	}
	if err != nil {
		return layoutSentinelError(err)
	}

	v := next.String()
	if err := tabSetWindowOptionsFn(ctx, windowID, server, []tmux.WindowOptionOp{{Key: tmux.LayoutOption, Value: &v}}); err != nil {
		return err
	}
	tabLayoutReport(sink, windowID, v)
	tabWakeFn(ctx, server)
	return nil
}

// tabServerWindows enumerates every window on the server across all sessions
// — the holder-lookup input for the live-in-one-place check. @N is unique per
// server, so a foreign leaf may name a window in any session.
func tabServerWindows(ctx context.Context, server string) ([]tmux.WindowInfo, error) {
	infos, err := tmux.ListSessions(ctx, server)
	if err != nil {
		return nil, err
	}
	var out []tmux.WindowInfo
	for _, si := range infos {
		windows, err := tmux.ListWindows(ctx, si.Name, server)
		if err != nil {
			return nil, err
		}
		out = append(out, windows...)
	}
	return out, nil
}

// tabLayoutReport prints the verb's one result line, or the --json receipt
// when the flag is set.
func tabLayoutReport(sink outputSink, windowID, layout string) {
	if tabLayoutJSONFlag {
		sink.JSONResult(tabLayoutReceipt{Window: windowID, Layout: layout})
		return
	}
	sink.Dataf("%s\n", layout)
}
