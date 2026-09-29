// Package mcp implements run-kit's MCP (Model Context Protocol) surface: a
// mechanical, allowlisted proxy over existing rk verbs (docs/specs/mcp.md).
// Every tool is exactly one verb invocation executed as an argv child process;
// the compiled-in policy Table is the only thing that exposes a verb. The
// package is transport-agnostic — rk mcp hosts it over stdio; nothing here may
// assume stdio (the daemon's /mcp route reuses New).
//
// The MCP SDK is imported under the mcpsdk alias because this package's own
// name collides with it.
package mcp

import (
	"time"

	"rk/internal/tmux"
)

// ToolTimeoutCap bounds every tool call's subprocess (docs/specs/mcp.md
// § Timeout contract: desktop MCP clients time out well under a minute). A row
// with Timeout 0 uses the cap; a row above the cap fails Resolve.
const ToolTimeoutCap = 45 * time.Second

// ArgType is the JSON-schema type of one tool input.
type ArgType int

const (
	ArgString ArgType = iota
	ArgInteger
	ArgBoolean
	// ArgStringArray is a JSON array of strings: a repeated flag
	// (--skill a --skill b) for a Flag input, one argv element per item for a
	// Positional input.
	ArgStringArray
)

// ResultKind selects how a verb's stdout becomes MCP content.
type ResultKind int

const (
	// ResultJSON parses the --json envelope, falling back to a bare JSON
	// document (the interim form) and then to text.
	ResultJSON ResultKind = iota
	// ResultText returns stdout verbatim and maps exit code to isError.
	ResultText
	// ResultImage reads the PNG at the path the verb printed on stdout.
	ResultImage
)

// Annotations carries the MCP tool annotations as plain bools; server
// construction maps them onto the SDK's pointer fields.
type Annotations struct {
	ReadOnly    bool
	Destructive bool
	Idempotent  bool
	OpenWorld   bool
}

// Arg maps one tool input onto argv. Exactly one of Flag / Positional /
// Literal applies; an input with none of them (e.g. send's message, tab_web's
// window/slot) is schema-only and travels on stdin when named by Row.Stdin or
// feeds a Format positional. BuildArgv is a single ordered walk over Args —
// every flag, flag-shaped literal, positional, and bare literal is emitted
// where it sits — so a row's Args order IS its argv order.
type Arg struct {
	Name        string   // input property name; "" for Literal and Format positionals
	Flag        string   // "-L", "--all", "-l" — mapped as flag [value]
	Positional  int      // 1-based positional slot (mutually exclusive with Flag)
	Literal     string   // fixed argv token appended in order ("--json", "-")
	Format      string   // positional token template: {name} substitutes an input, […] drops when an input inside is absent
	Type        ArgType  // String | Integer | Boolean | StringArray
	Required    bool     //
	Pattern     string   // JSON-schema pattern (strings)
	Enum        []string // closed set (strings)
	Minimum     *int     // integers
	Maximum     *int
	MaxItems    *int   // string arrays
	Description string // "" ⇒ the flag's pflag Usage string (positional args need one)
	// When (Literal args only) gates the literal on the named input being
	// present in the call — BuildArgv skips the token when the input is
	// absent. Resolve rejects a When naming no input of the row.
	When string
	// Default (Flag args only, never Boolean) is the argv value BuildArgv
	// emits for the flag when the input is absent; InputSchema surfaces it as
	// the JSON-schema default (a number for Integer args). Resolve rejects a
	// Default on a positional/Literal/Boolean arg and a non-integer Default on
	// an Integer arg.
	Default string
}

// Row is one allowlisted tool. The table is compiled in; a verb with no row is
// not a tool.
type Row struct {
	Tool        string        // MCP tool name — snake_case, unique, stable
	Path        string        // Cobra command path ("mux capture"); MUST resolve at startup
	Args        []Arg         // ordered input → argv mapping
	Stdin       string        // name of a string input streamed on stdin ("" = none)
	Result      ResultKind    // ResultJSON | ResultText | ResultImage
	Annotations Annotations   // ReadOnly, Destructive, Idempotent, OpenWorld
	Timeout     time.Duration // 0 ⇒ ToolTimeoutCap; MUST be ≤ ToolTimeoutCap (test-enforced)
	Description string        // "" ⇒ Cobra Short + "\n\n" + Long
	// OneOf lists input names of which exactly one must be present in a call;
	// ValidateArgs rejects zero or two before anything execs. Resolve rejects
	// a member naming no input of the row.
	OneOf []string
}

// neverTools are command paths that MUST NOT gain a policy row
// (docs/specs/mcp.md § Never tools). Matched as a prefix of a row's Path, so
// "daemon" covers every daemon member. Tier-two verbs are not listed — they
// are simply not seeded yet.
var neverTools = []string{
	"serve",
	"daemon",
	"remote",
	"desktop",
	"update",
	"agent setup",
	"agent hook",
	"mux guard",
	"mux init-conf",
	"completion",
	"shell-init",
	"help-dump",
	"skill",
	"role",
	"tutorial",
	"cron tick",
	"gui supervise",
	"gui env",
	"mcp",
}

// readOnlyAnn is the annotation set of every See row.
var readOnlyAnn = Annotations{ReadOnly: true, Destructive: false, Idempotent: true, OpenWorld: false}

// Shared inputs. serverArg maps onto the mux/tab/cron families' persistent
// -L flag; its description defaults to the flag's pflag usage at schema
// generation. targetArg and windowArg are positional, so they carry their own
// descriptions (there is no pflag usage to inherit).
var (
	serverArg = Arg{Name: "server", Flag: "-L", Type: ArgString}
	targetArg = Arg{
		Name: "target", Positional: 1, Type: ArgString, Required: true,
		Pattern:     `^(%\d+|@\d+|=.+:.+)$`,
		Description: "The pane or window to address: %N (pane), @N (window — resolves to its agent pane), or =session:window (exact)",
	}
	windowArg = Arg{
		Name: "window", Positional: 1, Type: ArgString, Required: true,
		Pattern:     `^@\d+$`,
		Description: "The tab to address, by window id (@N)",
	}
	jsonLiteral = Arg{Literal: "--json"}
)

func intPtr(n int) *int { return &n }

// statusDescription overrides `status`'s Cobra help because the verb
// hard-codes the runkit server and its help does not say so — terminal prose
// that would mislead a model (docs/specs/mcp.md § Policy table rules).
const statusDescription = "Session summary of the `runkit` tmux server only (the verb takes no server flag); use `sessions`/`panes` for any other server."

// sendDescription overrides `mux send`'s Cobra help for the model: it names
// the receipt's fields and keeps the load-bearing caveat — `delivered` is the
// injection engine's submission verification, not an acknowledgment from the
// agent.
const sendDescription = "Deliver a message into an agent's pane through run-kit's injection engine, gated on the pane's agent state (idle sends; waiting and active refuse; unknown warns and sends). The result is the delivery receipt: `report` (`delivered` means the engine verified the text was submitted — it does NOT mean the agent has acted on it; call `await` to wait for the agent's state, or `capture` to read the pane), `target` (the resolved pane id), `server`, and `enter` (true when Enter was sent). Failures return code operational with a `reason`: probe_failure (the paste never echoed; check the pane before resending — a resend would duplicate the staged text), staged_send_failure (text landed but Enter was not sent; press Enter in the pane to submit), submit_unverified (Enter was sent but the pane stayed unchanged; capture the pane before resending). `--force` is not exposed; answering a waiting agent or pressing a key is the `answer` tool."

// answerKeyEnum is the closed key set the answer tool may press (spec
// Allowlist v1: control chords are excluded — interrupting an agent is kill's
// job).
var answerKeyEnum = []string{"Enter", "Escape", "Tab", "Up", "Down", "Left", "Right", "Space", "BSpace", "y", "n", "1", "2", "3", "4", "5", "6", "7", "8", "9"}

// answerDescription overrides `mux send`'s Cobra help for the answer tool:
// the message-vs-key split and the gate posture are what a model needs to call
// it correctly.
const answerDescription = "Reply to a waiting agent or press one key in its pane — the two forms of `mux send`'s answer channel. Pass exactly one of `message` (the reply text for a waiting agent, submitted with Enter; receipt report `delivered`, enter true) or `key` (one tmux key name — for trust prompts, pickers, and menus; receipt report `sent`, enter false). A key press rides the plain gate: a `waiting` agent refuses a bare key (use `message` to reply) and an `active` agent refuses everything — never interrupt a working agent. Gate refusals return the verb's diagnostic as an operational error."

// awaitDescription overrides `mux await`'s Cobra help for the model: the
// report words and the running/re-arm contract are not obvious from terminal
// prose.
const awaitDescription = "Block until an agent pane reaches a state, then report the outcome: `report` is a reached `until` state (`idle`, or `waiting` — the agent is asking a question back; answer it with `answer`), or `running` (the timeout expired — nothing failed; call again to keep waiting). With `ready`, wait for a freshly spawned agent's BOOT readiness instead: `ready` (safe to type into; `detail` is `state` or `echo`), `parked` (a trust dialog or wall — read the pane with `capture` and answer it with `answer`), or `narrow` (the pane is below the 80x20 readiness floor; `detail` carries the WxH geometry — resize or relocate the pane). `until` and `ready` are mutually exclusive. The result also carries `target` (the pane; absent on running) and `elapsed_ms`. The pane dying mid-wait is an operational error with reason `gone`."

// boardDescription overrides `board`'s Cobra help — the family Long is
// terminal prose; the row description names each action's required inputs and
// the receipt shapes (docs/specs/mcp.md § New verb families).
const boardDescription = "List boards and pin/unpin/reorder windows on the cross-server board dashboards; rides the daemon, so rk serve must be up. Actions: `show` lists boards (no `name`) or one board's pinned windows (with `name`); `pin`, `unpin`, and `reorder` mutate and require `name` and `window`. `server` applies to the three mutations and defaults to `default`. `before`/`after` are reorder-only neighbour window ids (@N); passing neither appends. The result is the route body for `show` (a bare JSON array) or a {board, window, orderKey?} receipt for the mutations (orderKey on reorder only)."

// operatorTemplateIDs is the closed template registry's id set, mirrored here
// because internal/mcp must not import rk/api (the daemon's /mcp route would
// close an import cycle). cmd/rk's TestOperatorRequestEnumMatchesRegistry pins
// it to api.OperatorTemplateList(); a registry edit that forgets this list
// fails the build.
var operatorTemplateIDs = []string{
	"annotate-tab", "brief-me", "color-tabs", "find-discussion", "fix-tab-name",
	"spawn-task", "update-annotations", "user-message", "whats-stuck",
}

// operatorRequestDescription overrides `operator request`'s Cobra help for the
// model: the conditional-window rule and the acceptor postures are what a
// model needs to call the tool correctly, and the queued receipt's meaning is
// not obvious from a report word.
const operatorRequestDescription = "Hand the server's operator agent a templated work item through run-kit's operator-request lane (the same closed registry the dashboard's operator actions use). Window-scoped templates (fix-tab-name, annotate-tab, user-message) REQUIRE `window`; every other template is server-scoped and REJECTS it. `text` is accepted only by spawn-task, find-discussion, and user-message; `session` only by update-annotations. A busy operator queues the request and the result reports `queued:true` — the work is not lost, it drains when the operator goes idle (user-message skips the gate and is never queued). whats-stuck refuses when nothing on the server is waiting. The verb's `--list` is the source of truth for the template set and its flags."

// snapshotListDescription overrides `mux snapshot list`'s Cobra help: the verb
// has no Long of its own, and the parent's help describes the unexposed
// show/restore subcommands (docs/specs/mcp.md § Policy table rules).
const snapshotListDescription = "List layout-recovery snapshots of tmux servers, newest first. Each row is {server, taken_at, died_at, audited_kill, sessions, windows, history_count}; died_at is null for a live server and set on a died tombstone. `show` and `restore` are not exposed."

// guiShotDescription overrides `gui shot`'s Cobra help because its Long
// promises "the absolute path on stdout" (true only without --json) and names
// three flags this tool does not expose.
const guiShotDescription = "Capture a screenshot of the rk GUI display. Result is an image block (PNG) plus a text block carrying {path, width, height, scale, display}; width/height are the source geometry and scale the applied downscale. `--out`, `--scale`, and `--window` are not exposed — the capture always lands at the verb's temp path and covers the full display."

// goDurationPattern is the JSON-schema pattern for the duration-string inputs
// (Go duration syntax: one or more number+unit segments).
const goDurationPattern = `^[0-9]+(ns|us|µs|ms|s|m|h)([0-9]+(ns|us|µs|ms|s|m|h))*$`

// The W2c description overrides: Cobra help written for a terminal misleads a
// model on these rows (docs/specs/mcp.md § Policy table rules).
const (
	notifyDescription    = "Send a Web Push notification to the daemon's subscribed devices. Fail-silent by contract: the exit code is always 0, so the receipt's `delivered` field is the verdict — delivered:false (daemon unreachable, non-2xx, timeout) is NOT a tool error."
	riffDescription      = "Spawn a worktree + tmux window + agent pane set (optionally a named preset — run-kit's `riff_presets`: built-ins `discuss`, `incognito`, `blank`, plus user additions in ~/.config/hexokit/config.yaml). Over MCP `server` and `repo` are REQUIRED (the executor strips $TMUX and its cwd is not the repo): `server` is the tmux server label, `repo` an absolute path that must be the git toplevel, `session` (=S exact form) defaults to the server's current session. `skill` items are slash commands (e.g. /fab-discuss) rendered for the resolved provider; repeatable, one pane per item in order. `--cmd` (shell panes) is NOT available over MCP. The receipt's `windows[]` entries carry id/name/panes/worktree/branch; panes[0] is the task pane."
	newWindowDescription = "Open a new idle window (no command form over MCP) in the target session and return {session, session_rung, window_id, pane_id} — `session_rung` says why that session was chosen. `session` takes the =S exact form; without it the window lands in the caller's current session inside tmux (an _rk-* infrastructure caller instead picks a user session: sole user, else the one rooted at cwd's main worktree, else the most attached), else the target server's current session — over MCP the executor strips $TMUX, so that server rung is what applies. `cwd` sets the window's working directory."
	operatorDescription  = "Open (or ensure) the server's operator tab — a per-server singleton running the operator-tier agent. Idempotent: `created:false` means an operator already existed on that server (nothing is duplicated). Over MCP `server` is REQUIRED (the executor strips $TMUX). `workers` sets FAB_AGENT_WORKERS for the launched agent."
	cronAddDescription   = "Schedule a prompt for an agent on a tmux server. The prompt is TEXT TYPED INTO AN AGENT at fire time, never a command. Exactly ONE schedule input (every | idle_every | backoff | cron) and exactly ONE of role / pane / session are required (the verb enforces both and rejects a bad combination). The receipt carries {id, name, schedule, target} — the id feeds cron_mute/cron_rm."
	guiExecDescription   = "Start a GUI program on the rk desktop's display. ALWAYS detached: the receipt is the started {pid, display}, not the command's output. `command` is resolved on PATH; `args` are its argv (dash-prefixed values are safe — they follow a literal `--`). Pair with gui_status (is the desktop up?) and gui_shot (screenshot) to observe the result."
	killDescription      = "Kill a pane, gated on the pane's agent state and server protection: a pane whose agent is active or waiting (a pending human question) is REFUSED, as is any pane on a protected server — a refusal arrives as the verb's error. There is NO force path over MCP. `target` is %N (pane), @N (window — resolves to its agent pane), or =session:window (exact)."
	tabWebDescription    = "Mutate a tab's web-tab strip. Every action requires `window` (@N); the composite address @N/web/<slot> is rendered from `window` and `slot`. `add` requires `target` (a URL, :port, file, or directory) and takes optional `show` (ensure the web surface is in the layout and select the tab); `rm`/`select` require `slot`; `mv` requires `slot` and `to` (the destination slot). The receipt carries {window, index, url?, tabs} — tabs is the post-mutation family."
)

// Table is the compiled-in policy table — the allowlist (docs/specs/mcp.md
// § Policy table). Seeded with the verbs that are already MCP-shaped: the nine
// structured-today read verbs ride result: json on their existing bare
// documents until the --json envelope lands, send/answer/await ride result:
// json on the mux verbs' --json receipts, board rides result: json on its
// route bodies (show) and {board, window, orderKey?} receipts
// (pin/unpin/reorder), and the thirteen mutating W2c rows (notify…cron_mute)
// ride the --json envelope their verbs emit (new_window and code_exec are
// bare-JSON until the envelope lands on those verbs).
var Table = []Row{
	{
		Tool: "sessions", Path: "mux sessions",
		Args:        []Arg{serverArg, {Name: "all", Flag: "--all", Type: ArgBoolean}, jsonLiteral},
		Result:      ResultJSON,
		Annotations: readOnlyAnn,
	},
	{
		Tool: "panes", Path: "mux panes",
		Args:        []Arg{serverArg, jsonLiteral},
		Result:      ResultJSON,
		Annotations: readOnlyAnn,
	},
	{
		Tool: "capture", Path: "mux capture",
		Args: []Arg{
			serverArg,
			{Name: "lines", Flag: "-l", Type: ArgInteger, Minimum: intPtr(1), Maximum: intPtr(2000)},
			targetArg,
			jsonLiteral,
		},
		Result:      ResultJSON,
		Annotations: readOnlyAnn,
	},
	{
		Tool: "process", Path: "mux process",
		Args:        []Arg{serverArg, targetArg, jsonLiteral},
		Result:      ResultJSON,
		Annotations: readOnlyAnn,
	},
	{
		Tool: "status", Path: "status",
		Args:        []Arg{jsonLiteral},
		Result:      ResultJSON,
		Annotations: readOnlyAnn,
		Description: statusDescription,
	},
	{
		Tool: "cron_list", Path: "cron list",
		Args:        []Arg{serverArg, jsonLiteral},
		Result:      ResultJSON,
		Annotations: readOnlyAnn,
	},
	{
		Tool: "gui_status", Path: "gui status",
		Args:        []Arg{jsonLiteral},
		Result:      ResultJSON,
		Annotations: readOnlyAnn,
	},
	{
		Tool: "tab_show", Path: "tab show",
		Args:        []Arg{serverArg, windowArg, jsonLiteral},
		Result:      ResultJSON,
		Annotations: readOnlyAnn,
	},
	{
		Tool: "tab_web_ls", Path: "tab web ls",
		Args:        []Arg{serverArg, windowArg, jsonLiteral},
		Result:      ResultJSON,
		Annotations: readOnlyAnn,
	},
	{
		Tool: "send", Path: "mux send",
		Args: []Arg{
			serverArg,
			targetArg,
			{Name: "message", Type: ArgString, Required: true, Description: "The text to deliver; submitted with Enter"},
			{Literal: "-"},
			jsonLiteral,
		},
		Stdin:       "message",
		Result:      ResultJSON,
		Annotations: Annotations{},
		Description: sendDescription,
	},
	{
		// The one action-enum row besides tab_web: the parent path carries the
		// flags (BuildArgv emits each arg where it sits in Args — flags first
		// here keeps the historical flags-before-positionals argv), so
		// -L/--json/--before/--after MUST be persistent on the board command —
		// defining them on a child fails this drift guard.
		Tool: "board", Path: "board",
		Args: []Arg{
			serverArg,
			{Name: "before", Flag: "--before", Type: ArgString, Pattern: `^@\d+$`},
			{Name: "after", Flag: "--after", Type: ArgString, Pattern: `^@\d+$`},
			{Name: "action", Positional: 1, Type: ArgString, Required: true,
				Enum:        []string{"show", "pin", "unpin", "reorder"},
				Description: "show lists boards (no name) or one board's entries (with name); pin/unpin/reorder mutate and require name and window"},
			{Name: "name", Positional: 2, Type: ArgString, Pattern: `^[A-Za-z0-9_-]{1,32}$`,
				Description: "Board name; optional for show, required for pin/unpin/reorder"},
			{Name: "window", Positional: 3, Type: ArgString, Pattern: `^@\d+$`,
				Description: "The window to pin/unpin/reorder, by window id (@N); required for the three mutations"},
			jsonLiteral,
		},
		Result:      ResultJSON,
		Annotations: Annotations{}, // mixed read/write tool: no hints
		Description: boardDescription,
	},
	{
		Tool: "operator_request", Path: "operator request",
		Args: []Arg{
			serverArg,
			{Name: "window", Flag: "--window", Type: ArgString, Pattern: `^@\d+$`},
			{Name: "text", Flag: "--text", Type: ArgString},
			{Name: "session", Flag: "--session", Type: ArgString},
			{Name: "template", Positional: 1, Type: ArgString, Required: true, Enum: operatorTemplateIDs,
				Description: "The operator template id (closed registry; see the tool description for which take window/text/session)"},
			jsonLiteral,
		},
		Result:      ResultJSON,
		Annotations: Annotations{}, // Talk row: no annotations (spec allowlist "—")
		Description: operatorRequestDescription,
	},
	{
		// One tool for both answer forms: --answer applies only to the message
		// form (the When literals), so a bare key press rides the plain gate
		// column — a waiting agent refuses it.
		Tool: "answer", Path: "mux send",
		Args: []Arg{
			serverArg,
			{Name: "key", Flag: "--key", Type: ArgString,
				Enum:        answerKeyEnum,
				Description: "One tmux key name to press instead of a message — for trust prompts, pickers, and menus (mutually exclusive with message)"},
			targetArg,
			{Name: "message", Type: ArgString, Description: "The reply text for a waiting agent; submitted with Enter (mutually exclusive with key)"},
			{Literal: "--answer", When: "message"},
			{Literal: "-", When: "message"},
			jsonLiteral,
		},
		Stdin:       "message",
		OneOf:       []string{"message", "key"},
		Result:      ResultJSON,
		Annotations: Annotations{}, // Talk row: no annotations (spec allowlist "—")
		Description: answerDescription,
	},
	{
		// The timeout is structurally clamped to the proxy cap: bounded 1..40
		// by the schema with Default "40" emitted when absent, so the verb
		// always reports running before the 45s deadline (docs/specs/mcp.md
		// § Timeout contract). --any/--file/--after-active/--notify are not
		// exposed (a path, N targets, and no chat-client use).
		Tool: "await", Path: "mux await",
		Args: []Arg{
			serverArg,
			{Name: "until", Flag: "--until", Type: ArgString,
				Pattern:     `^(idle|waiting|active)(,(idle|waiting|active)){0,2}$`,
				Description: "Comma-separated agent states that end the wait (default idle); waiting wakes when the agent asks a question back"},
			{Name: "timeout", Flag: "--timeout", Type: ArgInteger, Minimum: intPtr(1), Maximum: intPtr(40), Default: "40",
				Description: "Seconds to wait before reporting running (1–40; default 40). On running, call again"},
			{Name: "ready", Flag: "--ready", Type: ArgBoolean,
				Description: "Wait for a freshly spawned agent's BOOT readiness instead of a state: ready | parked (a trust dialog or wall — read the pane and answer it with answer) | narrow (pane below 80x20). Mutually exclusive with until"},
			targetArg,
			jsonLiteral,
		},
		Result:      ResultJSON,
		Annotations: readOnlyAnn, // read-only even though it blocks
		Description: awaitDescription,
	},
	{
		// No serverArg: the verb rejects the inherited -L at runtime while the
		// drift guard would still resolve it — the positional filter is the
		// only server input. The pattern mirrors ValidateServerName
		// (serverNamePattern + MaxServerNameLength).
		Tool: "snapshot_list", Path: "mux snapshot list",
		Args: []Arg{
			{
				Name: "server", Positional: 1, Type: ArgString,
				Pattern:     `^[a-zA-Z0-9_-]{1,64}$`,
				Description: "Only this server's snapshots (live latest + died tombstones); omit for the store-wide list across every server",
			},
			jsonLiteral,
		},
		Result:      ResultJSON,
		Annotations: readOnlyAnn,
		Description: snapshotListDescription,
	},
	{
		// max_width is the only exposed input: --scale is float64 and --window
		// uint64 (both outside the drift guard's type set), and --out is a
		// filesystem path outside the target rule.
		Tool: "gui_shot", Path: "gui shot",
		Args: []Arg{
			{Name: "max_width", Flag: "--max-width", Type: ArgInteger, Minimum: intPtr(1)},
			jsonLiteral,
		},
		Result:      ResultImage,
		Annotations: readOnlyAnn,
		Description: guiShotDescription,
	},
	{
		Tool: "notify", Path: "notify",
		Args: []Arg{
			{Name: "message", Positional: 1, Type: ArgString, Required: true,
				Description: "The notification body"},
			{Name: "title", Flag: "--title", Type: ArgString},
			jsonLiteral,
		},
		Result:      ResultJSON,
		Annotations: Annotations{},
		Description: notifyDescription,
	},
	{
		// server and repo are required over MCP: the executor strips $TMUX and
		// its cwd is not the repo, so the verb's own defaults are unreachable
		// (docs/specs/mcp.md § Target rule). No --cmd — a pane shell command is
		// a shell string.
		Tool: "riff", Path: "riff",
		Args: []Arg{
			{Name: "server", Flag: "-L", Type: ArgString, Required: true, Pattern: `^[A-Za-z0-9_-]+$`,
				Description: "The tmux server label to spawn on"},
			{Name: "repo", Flag: "--repo", Type: ArgString, Required: true,
				Description: "Absolute path of the repo to spawn from; must be the git toplevel"},
			{Name: "session", Flag: "--session", Type: ArgString, Pattern: `^=.+$`,
				Description: "Session the window is created in (=S exact form; default: the server's current session)"},
			{Name: "preset", Positional: 1, Type: ArgString,
				Description: "Named preset from run-kit's riff_presets (built-ins: discuss, incognito, blank, plus user additions/overrides in ~/.config/hexokit/config.yaml)"},
			{Name: "skill", Flag: "--skill", Type: ArgStringArray,
				Description: "Slash command for a pane (repeatable, one pane per item in order; a bare item launches a blank agent)"},
			{Name: "layout", Flag: "--layout", Type: ArgString},
			{Name: "count", Flag: "-N", Type: ArgInteger, Minimum: intPtr(1), Maximum: intPtr(8),
				Description: "Spawn N worktree/window pairs in parallel"},
			jsonLiteral,
		},
		Result:      ResultJSON,
		Annotations: Annotations{},
		Description: riffDescription,
	},
	{
		Tool: "new_window", Path: "tab new",
		Args: []Arg{
			serverArg,
			{Name: "session", Flag: "--session", Type: ArgString, Pattern: `^=.+$`},
			{Name: "cwd", Flag: "--cwd", Type: ArgString},
			{Name: "name", Flag: "--name", Type: ArgString},
			{Name: "layout", Flag: "--layout", Type: ArgString},
			jsonLiteral,
		},
		Result:      ResultJSON,
		Annotations: Annotations{},
		Description: newWindowDescription,
	},
	{
		Tool: "operator", Path: "operator",
		Args: []Arg{
			{Name: "server", Flag: "-L", Type: ArgString, Required: true, Pattern: `^[A-Za-z0-9_-]+$`,
				Description: "The tmux server label whose operator to open"},
			{Name: "workers", Flag: "--workers", Type: ArgString, Pattern: `^[A-Za-z0-9_-]+$`},
			jsonLiteral,
		},
		Result:      ResultJSON,
		Annotations: Annotations{Idempotent: true},
		Description: operatorDescription,
	},
	{
		Tool: "cron_add", Path: "cron add",
		Args: []Arg{
			serverArg,
			{Name: "prompt", Positional: 1, Type: ArgString, Required: true,
				Description: "The text typed into the target agent at fire time (never a command)"},
			{Name: "every", Flag: "--every", Type: ArgString, Pattern: goDurationPattern,
				Description: "Fire on a fixed interval (Go duration, e.g. 1h, 90s)"},
			{Name: "idle_every", Flag: "--idle-every", Type: ArgString, Pattern: goDurationPattern,
				Description: "Fire every <dur> of agent quiet (a flat backoff ladder)"},
			{Name: "backoff", Flag: "--backoff", Type: ArgBoolean,
				Description: "Fire on a backoff ladder keyed on the target pane's idle epoch"},
			{Name: "min", Flag: "--min", Type: ArgString, Pattern: goDurationPattern,
				Description: "Backoff ladder minimum gap (with backoff)"},
			{Name: "max", Flag: "--max", Type: ArgString, Pattern: goDurationPattern,
				Description: "Backoff ladder maximum gap (with backoff)"},
			{Name: "cron", Flag: "--cron", Type: ArgString,
				Description: "Fire on a 5-field cron expression (daemon local time)"},
			{Name: "catch_up", Flag: "--catch-up", Type: ArgString, Enum: []string{"once"},
				Description: "With cron: fire once late after a gap"},
			{Name: "name", Flag: "--name", Type: ArgString},
			{Name: "deliver", Flag: "--deliver", Type: ArgString, Enum: []string{"immediate", "when-idle", "skip-if-busy"}},
			{Name: "if_absent", Flag: "--if-absent", Type: ArgString, Enum: []string{"skip", "notify"}},
			{Name: "pinned", Flag: "--pinned", Type: ArgBoolean},
			{Name: "role", Flag: "--role", Type: ArgString,
				Description: "Target a server role (the @rk_win_role value, e.g. operator)"},
			{Name: "pane", Flag: "--pane", Type: ArgString, Pattern: `^%\d+$`,
				Description: "Target a pane id (%N)"},
			{Name: "session", Flag: "--session", Type: ArgString,
				Description: "Target an agent session ref"},
			jsonLiteral,
		},
		Result:      ResultJSON,
		Annotations: Annotations{},
		Description: cronAddDescription,
	},
	{
		Tool: "tab_layout", Path: "tab layout",
		Args: []Arg{
			serverArg,
			windowArg,
			{Name: "layout", Positional: 2, Type: ArgString,
				Description: "The layout value to set — the tree form `h(tty,v(code,web))` or a legacy `<shape>:<surface,…>`; omit for a read, or use one mutation input instead"},
			{Name: "add", Flag: "--add", Type: ArgString, Enum: []string{"tty", "web", "code", "gui"},
				Description: "Add a surface (splits the last tile along its longer axis)"},
			{Name: "rm", Flag: "--rm", Type: ArgString, Enum: []string{"tty", "web", "code", "gui"},
				Description: "Remove a surface from the layout (its neighbours absorb the space)"},
			{Name: "promote", Flag: "--promote", Type: ArgString, Enum: []string{"tty", "web", "code", "gui"},
				Description: "Move a surface to slot A"},
			{Name: "cycle", Flag: "--cycle", Type: ArgBoolean,
				Description: "Cycle to the next template for the tile count"},
			jsonLiteral,
		},
		Result:      ResultJSON,
		Annotations: Annotations{},
	},
	{
		// The board precedent: one row on the parent path, action as positional
		// 1, the flags persistent on the parent; window/slot are schema-only and
		// feed the formatted composite address @N[/web/<slot>]. Per-action
		// required-ness (target for add, slot for rm/select/mv, to for mv) is
		// enforced by the verb's own usage errors.
		Tool: "tab_web", Path: "tab web",
		Args: []Arg{
			{Name: "action", Positional: 1, Type: ArgString, Required: true,
				Enum:        []string{"add", "rm", "select", "mv"},
				Description: "add attaches a target to the strip; rm/select address a slot; mv moves a slot"},
			serverArg,
			{Name: "window", Type: ArgString, Required: true, Pattern: `^@\d+$`,
				Description: "The tab to address, by window id (@N)"},
			{Name: "slot", Type: ArgInteger, Minimum: intPtr(1), Maximum: intPtr(tmux.MaxWebTabs),
				Description: "The web-tab slot; required for rm/select/mv"},
			{Positional: 2, Format: "{window}[/web/{slot}]"},
			{Name: "target", Positional: 3, Type: ArgString,
				Description: "add's target: a URL, :port, file, or directory"},
			{Name: "to", Positional: 4, Type: ArgInteger, Minimum: intPtr(1), Maximum: intPtr(tmux.MaxWebTabs),
				Description: "mv's destination slot"},
			{Name: "show", Flag: "--show", Type: ArgBoolean,
				Description: "add only: ensure the web surface is in the layout and select the tab"},
			jsonLiteral,
		},
		Result:      ResultJSON,
		Annotations: Annotations{},
		Description: tabWebDescription,
	},
	{
		Tool: "tab_code", Path: "tab code set",
		Args: []Arg{
			serverArg,
			windowArg,
			{Name: "folder", Positional: 2, Type: ArgString, Required: true,
				Description: "The folder the code surface opens (must exist)"},
			jsonLiteral,
		},
		Result:      ResultJSON,
		Annotations: Annotations{},
	},
	{
		Tool: "code_exec", Path: "code exec",
		Args: []Arg{
			{Name: "command", Positional: 1, Type: ArgString, Required: true,
				Description: "The code-server CLI command (e.g. ls, read, grep)"},
			{Name: "args", Positional: 2, Type: ArgStringArray,
				Description: "The command's arguments (JSON literals as strings, each one argv element)"},
			{Name: "host", Flag: "--host", Type: ArgString},
			{Name: "tab", Flag: "--tab", Type: ArgString, Pattern: `^@\d+$`},
			{Name: "folder", Flag: "--folder", Type: ArgString},
			{Name: "timeout", Flag: "--timeout", Type: ArgString, Pattern: goDurationPattern},
			{Name: "all", Flag: "--all", Type: ArgBoolean},
			jsonLiteral,
		},
		Result:      ResultJSON,
		Annotations: Annotations{},
	},
	{
		// Fixed --detach (the foreground path replaces the process and returns
		// no receipt) and a literal `--` so dash-prefixed program args pass
		// through — the ordered walk places both before the positionals.
		Tool: "gui_exec", Path: "gui exec",
		Args: []Arg{
			{Literal: "--detach"},
			jsonLiteral,
			{Literal: "--"},
			{Name: "command", Positional: 1, Type: ArgString, Required: true,
				Description: "The program to start on the GUI display (resolved on PATH)"},
			{Name: "args", Positional: 2, Type: ArgStringArray,
				Description: "The program's argv (each item one argv element)"},
		},
		Result:      ResultJSON,
		Annotations: Annotations{},
		Description: guiExecDescription,
	},
	{
		Tool: "kill", Path: "mux kill",
		Args:        []Arg{serverArg, targetArg, jsonLiteral},
		Result:      ResultJSON,
		Annotations: Annotations{Destructive: true},
		Description: killDescription,
	},
	{
		Tool: "cron_rm", Path: "cron rm",
		Args: []Arg{
			serverArg,
			{Name: "id", Positional: 1, Type: ArgString, Required: true,
				Description: "The cron entry id (from cron_add's receipt or cron_list)"},
			jsonLiteral,
		},
		Result:      ResultJSON,
		Annotations: Annotations{Destructive: true},
	},
	{
		Tool: "cron_mute", Path: "cron mute",
		Args: []Arg{
			serverArg,
			{Name: "id", Positional: 1, Type: ArgString, Required: true,
				Description: "The cron entry id (from cron_add's receipt or cron_list)"},
			{Name: "for", Flag: "--for", Type: ArgString, Pattern: goDurationPattern,
				Description: "Mute until now+<dur> (a self-expiring lease)"},
			{Name: "off", Flag: "--off", Type: ArgBoolean,
				Description: "Unmute instead of mute"},
			jsonLiteral,
		},
		Result:      ResultJSON,
		Annotations: Annotations{Idempotent: true},
	},
}
