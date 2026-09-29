package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"sort"
	"strings"
	"text/tabwriter"
	"time"

	"rk/internal/codebridge"
	"rk/internal/tmux"

	"github.com/spf13/cobra"
)

// rk code — the shell side of the rk-code-bridge channel: the code-server
// extension (installed by rk code-server install) serves one same-user Unix
// socket per open folder and registers a host record under the hexokit state
// dir; these verbs resolve a host and speak NDJSON to it. The registry is a
// discovery hint only — liveness is re-derived on every call
// (internal/codebridge.LiveHosts), never cached (Constitution II).
//
// Exit codes follow the toolkit convention (Principle 4): 0 ok, 1 operational
// (no host, dial failure, timeout/threw/unknown-command/bad-request), 2 usage
// (missing command, --host with --folder, unknown flag). Output follows the
// sink convention: result data is Dataf (stdout, survives --quiet); the
// using-host note, prune notices, and the version-skew warning are Notef
// (stderr); error lines are ungated stderr writes in the
// `error: <kind>: <message>` form, so they always survive --quiet.

const (
	// codeDefaultTimeout is the per-command timeout the extension enforces
	// when --timeout is not given.
	codeDefaultTimeout = 30 * time.Second
	// codeDeadlineSlack is added to --timeout for the Go dial+read deadline
	// so the extension's own timeout error wins while a hung host stays
	// bounded.
	codeDeadlineSlack = 2 * time.Second
	// codeGitToplevelTimeout bounds the git rev-parse probe for the default
	// --folder (Constitution §I: explicit timeout on every subprocess).
	codeGitToplevelTimeout = 5 * time.Second
)

var (
	codeExecFolderFlag  string
	codeExecHostFlag    string
	codeExecTabFlag     string
	codeExecAllFlag     bool
	codeExecTimeoutFlag time.Duration
	codeExecJSONFlag    bool
	codeHostsJSONFlag   bool
	codeCmdsFolderFlag  string
	codeCmdsHostFlag    string
	codeCmdsTabFlag     string
)

var codeCmd = &cobra.Command{
	Use:   "code",
	Short: "Run VS Code commands in the code lens editor from the shell",
	Long: `Act inside the code-server editor behind the dashboard's /code lens.

The rk-code-bridge extension (installed by 'rk code-server install') opens a
same-user Unix socket per open folder and registers a host record under the
run-kit state dir; these subcommands are the shell side of that channel.
'exec' runs any palette command by id, 'hosts' lists the live hosts, and
'commands' lists what a host's palette can do.

The bridge is local-only and same-user by design: sockets live under the
user's state dir with 0600 permissions and nothing is ever bound to TCP.

Subcommands:
  exec      Run a VS Code command on the resolved host
  hosts     List live code-bridge hosts (pruning dead records)
  commands  List the command ids a host can execute

See 'run-kit code <subcommand> --help' for details.`,
}

var codeExecCmd = &cobra.Command{
	Use:   "exec <command> [json-arg…]",
	Short: "Execute a VS Code command in a code-bridge host",
	Long: `Execute a VS Code command (any palette command id) inside a code-bridge
host — one code-server window with the rk-code-bridge extension active — and
print its result.

Each positional after the command id is parsed as a JSON literal: numbers
stay numbers, objects pass through verbatim (the {"$uri":"file:///…"} marker
is rewritten to a vscode.Uri by the extension), and anything that is not
valid JSON is sent as a string, so bare words work. A literal '--' ends flag
parsing, so negative numbers and dash-prefixed strings pass as args.

Host resolution: --host wins; then --tab (a direct match on the tab identity,
with the tab's @rk_win_code_root as the folder fallback; an empty root falls
through to the cwd default with a note); then --folder (default: the caller's
own tab when inside tmux, then the git toplevel of the cwd) matched exact,
then longest-prefix, against the hosts' folders; then a single live host as
fallback. --all fans out to every live host (ignoring --tab).

Output: the result JSON on stdout ('null' prints null); --json wraps the
bridge response envelope verbatim in the standard {"ok":true,"result":…}
envelope — the outer ok is rk's, the inner the bridge's (with --all, a JSON
array of {hostId, folder, response}, ok:false when any host failed).
Exit codes: 0 ok; 1 operational (no host, dial failure, timeout, threw,
unknown-command, bad-request); 2 usage. On unknown-command the closest
matches from the host's command list print as a did-you-mean list on stderr.`,
	Args:         cobra.MinimumNArgs(1),
	SilenceUsage: true,
	RunE:         runCodeExec,
}

var codeHostsCmd = &cobra.Command{
	Use:   "hosts [--json]",
	Short: "List live code-bridge hosts",
	Long: `List the live code-bridge hosts as aligned rows (ID FOLDER TAB SERVER
PID AGE EXT; TAB/SERVER are the host's tab identity, '-' for a host opened
without one, age humanised from the record's startedAt) on stdout.

Liveness is re-derived on every call: a record counts only when its pid is
alive AND its socket answers a ping within 2s; records failing either check
are pruned as a side effect. Zero hosts prints nothing ([] under --json) and
exits 0. --json prints the host records as a JSON array inside the standard
{"ok":true,"result":…} envelope.`,
	Args:         cobra.NoArgs,
	SilenceUsage: true,
	RunE:         runCodeHosts,
}

var codeCommandsCmd = &cobra.Command{
	Use:   "commands [--folder <path>]",
	Short: "List the command ids a code-bridge host can execute",
	Long: `Resolve a code-bridge host exactly like 'rk code exec' (--host wins, then
--tab — a direct tab-identity match plus the tab's @rk_win_code_root — then
--folder or the default: the caller's own tab inside tmux, else the git
toplevel of the cwd, then the single-host fallback), ask
it for the full vscode.commands.getCommands(true) list, and print one command
id per line, sorted — a grep-able view of what the palette can do.`,
	Args:         cobra.NoArgs,
	SilenceUsage: true,
	RunE:         runCodeCommands,
}

func init() {
	// Flag help strings carry no backticks: pflag treats backtick-quoted text
	// in a usage string as the metavar name.
	codeExecCmd.Flags().StringVar(&codeExecFolderFlag, "folder", "",
		"Target host by workspace folder (default: git toplevel of the cwd)")
	codeExecCmd.Flags().StringVar(&codeExecHostFlag, "host", "",
		"Target host by id (see rk code hosts)")
	codeExecCmd.Flags().StringVar(&codeExecTabFlag, "tab", "",
		"Target the host whose folder is the tab's @rk_win_code_root (bare --tab = the caller's own tab; pass @N for another; --all ignores it)")
	codeExecCmd.Flags().Lookup("tab").NoOptDefVal = presentFlagAuto
	codeExecCmd.Flags().BoolVar(&codeExecAllFlag, "all", false,
		"Fan out to every live host")
	codeExecCmd.Flags().DurationVar(&codeExecTimeoutFlag, "timeout", codeDefaultTimeout,
		"Timeout the extension enforces on the command (the Go deadline adds 2s)")
	codeExecCmd.Flags().BoolVar(&codeExecJSONFlag, "json", false,
		"Print the bridge response nested under result in the {\"ok\",\"result\"} envelope instead of the bare result")
	codeExecCmd.MarkFlagsMutuallyExclusive("host", "folder")
	codeExecCmd.MarkFlagsMutuallyExclusive("tab", "host")
	codeExecCmd.MarkFlagsMutuallyExclusive("tab", "folder")

	codeHostsCmd.Flags().BoolVar(&codeHostsJSONFlag, "json", false,
		"Print the host records as a JSON array inside the {\"ok\",\"result\"} envelope")

	codeCommandsCmd.Flags().StringVar(&codeCmdsFolderFlag, "folder", "",
		"Target host by workspace folder (default: git toplevel of the cwd)")
	codeCommandsCmd.Flags().StringVar(&codeCmdsHostFlag, "host", "",
		"Target host by id (see rk code hosts)")
	codeCommandsCmd.Flags().StringVar(&codeCmdsTabFlag, "tab", "",
		"Target the host whose folder is the tab's @rk_win_code_root (bare --tab = the caller's own tab; pass @N for another)")
	codeCommandsCmd.Flags().Lookup("tab").NoOptDefVal = presentFlagAuto
	codeCommandsCmd.MarkFlagsMutuallyExclusive("host", "folder")
	codeCommandsCmd.MarkFlagsMutuallyExclusive("tab", "host")
	codeCommandsCmd.MarkFlagsMutuallyExclusive("tab", "folder")

	codeCmd.AddCommand(codeExecCmd)
	codeCmd.AddCommand(codeHostsCmd)
	codeCmd.AddCommand(codeCommandsCmd)

	// Arg-count violations on the children are usage-class (exit 2). root.go's
	// central wrap loop covers only rootCmd's direct children, so nested
	// subcommands wrap their own validators here (same one-place idiom as
	// code_server.go).
	for _, c := range codeCmd.Commands() {
		if c.Args != nil {
			c.Args = usageArgs(c.Args)
		}
	}
}

// codeTargetFolderFn / codeEmbeddedFn are package seams (the present.go
// pattern) so tests drive folder resolution and the bundled-version check
// without a git repo or an embedded VSIX.
var (
	codeTargetFolderFn = codeTargetFolder
	codeEmbeddedFn     = codebridge.Embedded
)

// codeTargetFolder resolves the default --folder: the git toplevel of the
// cwd, falling back to the cwd itself when not inside a repo (or when git is
// unavailable) — a folder match against the hosts still beats the
// single-host fallback.
func codeTargetFolder(ctx context.Context) (string, error) {
	cwd, err := os.Getwd()
	if err != nil {
		return "", fmt.Errorf("resolving working directory: %w", err)
	}
	gitCtx, cancel := context.WithTimeout(ctx, codeGitToplevelTimeout)
	defer cancel()
	out, err := exec.CommandContext(gitCtx, "git", "-C", cwd, "rev-parse", "--show-toplevel").Output()
	if err != nil {
		return cwd, nil
	}
	if top := strings.TrimSpace(string(out)); top != "" {
		return top, nil
	}
	return cwd, nil
}

// codeContext returns the command's context; direct RunE invocations (the
// package's test idiom) leave it nil, so fall back explicitly.
func codeContext(cmd *cobra.Command) context.Context {
	if ctx := cmd.Context(); ctx != nil {
		return ctx
	}
	return context.Background()
}

// codeRequestID returns a fresh random request id (8 bytes hex).
func codeRequestID() string {
	var b [8]byte
	if _, err := rand.Read(b[:]); err != nil {
		return fmt.Sprintf("%d", time.Now().UnixNano())
	}
	return hex.EncodeToString(b[:])
}

// codeLiveHosts enumerates the live hosts (both cb discovery dirs — the
// resolved one and the legacy dual-read one), printing a prune notice per
// dead record (Notef — chatter; --quiet drops it).
func codeLiveHosts(ctx context.Context, sink outputSink) ([]codebridge.HostRecord, error) {
	live, pruned, err := codebridge.LiveHostsMerged(ctx)
	if err != nil {
		return nil, err
	}
	for _, p := range pruned {
		sink.Notef("pruned dead code-bridge host record %s (%s)\n", p.HostID, p.Folder)
	}
	return live, nil
}

// codeSkewWarn prints the version-skew warning when the host's extension is
// older than the bundled one. A dev build without an embedded VSIX skips
// silently — codebridge.Embedded's ok=false is a state, not an error.
func codeSkewWarn(sink outputSink, host codebridge.HostRecord) {
	_, bundled, ok := codeEmbeddedFn()
	if !ok || host.ExtVersion == "" {
		return
	}
	if codebridge.OlderThan(host.ExtVersion, bundled) {
		sink.Notef("code bridge extension v%s is older than the bundled v%s — run rk code-server update\n", host.ExtVersion, bundled)
	}
}

// codeGetWindowOptionFn is the @rk_win_code_root read seam behind the --tab
// arm (the codeTargetFolderFn pattern) so tests drive the tab resolution
// without a live server.
var codeGetWindowOptionFn = func(ctx context.Context, windowID, server, option string) (string, error) {
	return tmux.GetWindowOption(ctx, windowID, server, option)
}

// resolveCodeHost maps the --host/--tab/--folder flags (and the own-tab /
// git-toplevel defaults) onto codebridge.Resolve, renders the failure
// classes, and applies the using-host note (single-host fallback) and the
// version-skew warning to the chosen host. Order: --host wins; --tab sets the
// tab-direct selector from the resolved address AND the tab's
// @rk_win_code_root as the folder fallback (empty root falls through to the
// cwd default with a note); an explicit --folder; with no flags at all, a
// caller inside a tmux pane gets its own tab as the direct selector
// (best-effort — outside tmux or on any error the step is skipped silently)
// before the cwd-toplevel folder ladder. tab is "" when the flag is absent,
// presentFlagAuto for a bare --tab (own tab), or an address.
func resolveCodeHost(cmd *cobra.Command, sink outputSink, ctx context.Context, live []codebridge.HostRecord, hostID, folder, tab string) (codebridge.HostRecord, error) {
	sel := codebridge.Selector{HostID: hostID, Folder: folder}
	if sel.HostID == "" && tab != "" {
		windowID, server, tabFolder, err := codeTabTarget(ctx, sink, tab)
		if err != nil {
			return codebridge.HostRecord{}, err
		}
		sel.Tab, sel.Server = windowID, server
		if tabFolder != "" {
			sel.Folder = tabFolder
		}
	}
	if sel.HostID == "" && tab == "" && sel.Folder == "" {
		if windowID, server, err := ownWindowID(ctx); err == nil {
			sel.Tab, sel.Server = windowID, server
		}
	}
	if sel.HostID == "" && sel.Folder == "" {
		f, err := codeTargetFolderFn(ctx)
		if err != nil {
			return codebridge.HostRecord{}, err
		}
		sel.Folder = f
	}
	host, fallback, err := codebridge.Resolve(ctx, live, sel)
	if err != nil {
		return codebridge.HostRecord{}, codeResolveError(cmd, sel, err)
	}
	if fallback {
		sink.Notef("using host %s (%s)\n", host.HostID, host.Folder)
	}
	codeSkewWarn(sink, host)
	return host, nil
}

// codeTabTarget resolves the --tab address to the (windowID, server)
// tab-direct key plus the tab's @rk_win_code_root ("" = fall through to the
// cwd default, with a note). The address is @N, =session:window, or the
// presentFlagAuto sentinel for the caller's own tab.
func codeTabTarget(ctx context.Context, sink outputSink, tab string) (windowID, server, codeRoot string, err error) {
	addrArg := tab
	if tab == presentFlagAuto {
		addrArg = ""
	}
	if _, windowID, server, err = resolveTabAddr(ctx, addrArg, ""); err != nil {
		return "", "", "", err
	}
	if codeRoot, err = codeGetWindowOptionFn(ctx, windowID, server, tmux.CodeRootOption); err != nil {
		return "", "", "", err
	}
	if codeRoot == "" {
		sink.Notef("tab %s has no @rk_win_code_root — falling back to the cwd\n", windowID)
	}
	return windowID, server, codeRoot, nil
}

// codeResolveError prints the resolution failure — the ambiguous case lists
// the live hosts, the none case prints the open-the-lens hint — and keeps
// cobra's own Error: line from duplicating it.
func codeResolveError(cmd *cobra.Command, sel codebridge.Selector, err error) error {
	w := cmd.ErrOrStderr()
	var hle *codebridge.HostListError
	switch {
	case errors.Is(err, codebridge.ErrAmbiguous):
		fmt.Fprintln(w, "error: multiple live code-bridge hosts — pass --host to pick one:")
		if errors.As(err, &hle) {
			for _, h := range hle.Hosts {
				fmt.Fprintf(w, "  %s  %s  %s\n", h.HostID, h.Folder, codeColumn(h.Tab))
			}
		}
	case errors.Is(err, codebridge.ErrNoHost):
		if sel.HostID != "" {
			fmt.Fprintf(w, "error: no code-bridge host with id %s\n", sel.HostID)
			if errors.As(err, &hle) {
				for _, h := range hle.Hosts {
					fmt.Fprintf(w, "  %s  %s\n", h.HostID, h.Folder)
				}
			}
		} else {
			fmt.Fprintf(w, "error: no code-bridge host — open the code lens on %s (or check `rk doctor`)\n", sel.Folder)
		}
	default:
		return err
	}
	cmd.SilenceErrors = true
	return err
}

// codeCallHost sends one request to a host. The Go deadline adds
// codeDeadlineSlack to the extension-enforced timeout so the extension's own
// timeout error wins while a hung host stays bounded.
func codeCallHost(ctx context.Context, host codebridge.HostRecord, command string, args []json.RawMessage, timeout time.Duration) (codebridge.Response, error) {
	callCtx, cancel := context.WithTimeout(ctx, timeout+codeDeadlineSlack)
	defer cancel()
	return codebridge.Call(callCtx, host.Sock, codebridge.Request{
		ID:        codeRequestID(),
		Command:   command,
		Args:      args,
		TimeoutMs: timeout.Milliseconds(),
	})
}

// codeResultJSON renders a result for stdout; an absent result prints null.
func codeResultJSON(resp codebridge.Response) string {
	if len(resp.Result) == 0 {
		return "null"
	}
	return string(resp.Result)
}

// codeTransportError renders a dial/read failure in the contract's
// error: … form (a transport failure has no bridge kind; the message says
// what failed) and keeps cobra's own Error: line from duplicating it.
func codeTransportError(cmd *cobra.Command, err error) error {
	fmt.Fprintf(cmd.ErrOrStderr(), "error: %s\n", strings.TrimPrefix(err.Error(), "codebridge: "))
	cmd.SilenceErrors = true
	return err
}

// codeBridgeError renders a failed response envelope as
// `error: <kind>: <message>`; on unknown-command it fetches the host's
// command list and prints the closest matches as a did-you-mean list (the
// suggestion fetch is best-effort — a host that just died loses the list,
// never the error line).
func codeBridgeError(cmd *cobra.Command, ctx context.Context, host codebridge.HostRecord, command string, resp codebridge.Response) error {
	kind, message := codebridge.ErrKindBadRequest, "request failed"
	if resp.Error != nil {
		kind, message = resp.Error.Kind, resp.Error.Message
	}
	w := cmd.ErrOrStderr()
	fmt.Fprintf(w, "error: %s: %s\n", kind, message)
	if kind == codebridge.ErrKindUnknownCommand {
		if all, err := codeFetchCommands(ctx, host); err == nil {
			if near := codebridge.Closest(command, all, 5); len(near) > 0 {
				fmt.Fprintln(w, "did you mean:")
				for _, id := range near {
					fmt.Fprintf(w, "  %s\n", id)
				}
			}
		}
	}
	cmd.SilenceErrors = true
	return fmt.Errorf("%s: %s", kind, message)
}

// codeFetchCommands runs __commands against a host — the rk code commands
// verb and the unknown-command suggestion fetch share it.
func codeFetchCommands(ctx context.Context, host codebridge.HostRecord) ([]string, error) {
	resp, err := codeCallHost(ctx, host, "__commands", nil, codeDefaultTimeout)
	if err != nil {
		return nil, err
	}
	if !resp.OK {
		if resp.Error != nil {
			return nil, fmt.Errorf("%s: %s", resp.Error.Kind, resp.Error.Message)
		}
		return nil, errors.New("__commands failed")
	}
	var ids []string
	if err := json.Unmarshal(resp.Result, &ids); err != nil {
		return nil, fmt.Errorf("decoding __commands result: %w", err)
	}
	return ids, nil
}

func runCodeExec(cmd *cobra.Command, args []string) error {
	if codeExecTimeoutFlag <= 0 {
		return usageError(fmt.Errorf("--timeout must be a positive duration"))
	}
	sink := newSink(cmd)
	ctx := codeContext(cmd)

	live, err := codeLiveHosts(ctx, sink)
	if err != nil {
		return err
	}

	if codeExecAllFlag {
		return runCodeExecAll(cmd, sink, ctx, live, args[0], codebridge.ParseArgs(args[1:]))
	}

	host, err := resolveCodeHost(cmd, sink, ctx, live, codeExecHostFlag, codeExecFolderFlag, codeExecTabFlag)
	if err != nil {
		return err
	}
	resp, err := codeCallHost(ctx, host, args[0], codebridge.ParseArgs(args[1:]), codeExecTimeoutFlag)
	if err != nil {
		return codeTransportError(cmd, err)
	}
	if !resp.OK {
		return codeBridgeError(cmd, ctx, host, args[0], resp)
	}
	if codeExecJSONFlag {
		return sink.Envelope(resp, nil)
	}
	sink.Dataf("%s\n", codeResultJSON(resp))
	return nil
}

// codeAllResult is one host's entry in the exec --all --json array. A host
// that failed at the transport layer carries a synthesized not-ok envelope so
// the array always has one entry per live host.
type codeAllResult struct {
	HostID   string              `json:"hostId"`
	Folder   string              `json:"folder"`
	Response codebridge.Response `json:"response"`
}

// runCodeExecAll fans one request out to every live host: default output is
// one `<hostId>\t<result JSON>` row per successful host; --json prints the
// {hostId, folder, response} array inside the envelope (ok:false alongside the
// array when any host failed). The exit is 1 when any host errored.
func runCodeExecAll(cmd *cobra.Command, sink outputSink, ctx context.Context, live []codebridge.HostRecord, command string, args []json.RawMessage) error {
	if len(live) == 0 {
		folder, err := codeTargetFolderFn(ctx)
		if err != nil {
			return err
		}
		fmt.Fprintf(cmd.ErrOrStderr(), "error: no code-bridge host — open the code lens on %s (or check `rk doctor`)\n", folder)
		cmd.SilenceErrors = true
		return codebridge.ErrNoHost
	}

	results := make([]codeAllResult, 0, len(live))
	skewWarned := false // the skew warning fires at most once per invocation
	failed := false
	for _, host := range live {
		if !skewWarned {
			if _, bundled, ok := codeEmbeddedFn(); ok && host.ExtVersion != "" && codebridge.OlderThan(host.ExtVersion, bundled) {
				codeSkewWarn(sink, host)
				skewWarned = true
			}
		}
		resp, err := codeCallHost(ctx, host, command, args, codeExecTimeoutFlag)
		if err != nil {
			failed = true
			msg := strings.TrimPrefix(err.Error(), "codebridge: ")
			fmt.Fprintf(cmd.ErrOrStderr(), "error: %s: %s\n", host.HostID, msg)
			resp = codebridge.Response{OK: false, Error: &codebridge.BridgeError{Kind: "transport", Message: msg}}
		} else if !resp.OK {
			failed = true
			kind, message := codebridge.ErrKindBadRequest, "request failed"
			if resp.Error != nil {
				kind, message = resp.Error.Kind, resp.Error.Message
			}
			fmt.Fprintf(cmd.ErrOrStderr(), "error: %s: %s: %s\n", host.HostID, kind, message)
		}
		results = append(results, codeAllResult{HostID: host.HostID, Folder: host.Folder, Response: resp})
		if !codeExecJSONFlag && resp.OK {
			sink.Dataf("%s\t%s\n", host.HostID, codeResultJSON(resp))
		}
	}

	var verdictErr error
	if failed {
		cmd.SilenceErrors = true
		verdictErr = errors.New("at least one host failed")
	}
	if codeExecJSONFlag {
		return sink.Envelope(results, verdictErr)
	}
	return verdictErr
}

func runCodeHosts(cmd *cobra.Command, _ []string) error {
	sink := newSink(cmd)
	live, err := codeLiveHosts(codeContext(cmd), sink)
	if err != nil {
		return err
	}
	if codeHostsJSONFlag {
		if live == nil {
			live = []codebridge.HostRecord{}
		}
		return sink.Envelope(live, nil)
	}
	if len(live) == 0 {
		return nil // zero hosts print nothing (still exit 0)
	}
	var buf bytes.Buffer
	tw := tabwriter.NewWriter(&buf, 0, 0, 2, ' ', 0)
	fmt.Fprintln(tw, "ID\tFOLDER\tTAB\tSERVER\tPID\tAGE\tEXT")
	for _, h := range live {
		fmt.Fprintf(tw, "%s\t%s\t%s\t%s\t%d\t%s\t%s\n", h.HostID, h.Folder, codeColumn(h.Tab), codeColumn(h.Server), h.PID, codeAge(h.StartedAt, time.Now()), h.ExtVersion)
	}
	if err := tw.Flush(); err != nil {
		return err
	}
	sink.Dataf("%s", buf.String())
	return nil
}

// codeColumn renders an optional host field for the hosts table and the
// ambiguous-hosts listing; an absent field (no tab identity) shows the
// placeholder.
func codeColumn(v string) string {
	if v == "" {
		return "-"
	}
	return v
}

// codeAge humanises a record's startedAt (RFC 3339) for the hosts table. A
// malformed timestamp renders as unknown rather than breaking the listing.
func codeAge(startedAt string, now time.Time) string {
	t, err := time.Parse(time.RFC3339, startedAt)
	if err != nil {
		return "unknown"
	}
	d := now.Sub(t)
	if d < 0 {
		d = 0
	}
	switch {
	case d < time.Minute:
		return fmt.Sprintf("%ds", int(d.Seconds()))
	case d < time.Hour:
		return fmt.Sprintf("%dm", int(d.Minutes()))
	case d < 24*time.Hour:
		return fmt.Sprintf("%dh", int(d.Hours()))
	default:
		return fmt.Sprintf("%dd", int(d.Hours()/24))
	}
}

func runCodeCommands(cmd *cobra.Command, _ []string) error {
	sink := newSink(cmd)
	ctx := codeContext(cmd)
	live, err := codeLiveHosts(ctx, sink)
	if err != nil {
		return err
	}
	host, err := resolveCodeHost(cmd, sink, ctx, live, codeCmdsHostFlag, codeCmdsFolderFlag, codeCmdsTabFlag)
	if err != nil {
		return err
	}
	ids, err := codeFetchCommands(ctx, host)
	if err != nil {
		fmt.Fprintf(cmd.ErrOrStderr(), "error: %s\n", err)
		cmd.SilenceErrors = true
		return err
	}
	sort.Strings(ids)
	for _, id := range ids {
		sink.Dataf("%s\n", id)
	}
	return nil
}
