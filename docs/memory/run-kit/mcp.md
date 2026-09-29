---
type: memory
description: "The rk MCP surface — `rk mcp` (stdio) and the daemon's `/mcp` route over `internal/mcp`: the compiled-in policy table (no row ⇒ no tool), Cobra-introspected schemas with the `Resolve` drift guard, the argv `Executor` (stdin, 45 s cap, `TMUX` stripped), the three-tier JSON parser plus image mapping, 29 seeded tools (every allowlist-v1 row but `present`; `board`/`tab_web` action enums), the `OriginPolicy`-guarded SDK transport, the `rk doctor` rows, `rk url --mcp`, and the E2E harness."
---
# rk MCP Surface

**Domain**: run-kit

## Overview

run-kit exposes an MCP (Model Context Protocol) surface: a mechanical, allowlisted proxy over existing `rk` verbs, so a chat client with no shell on the box can see and steer the estate. Two transports serve the same `internal/mcp` server: `rk mcp` over stdio (the Claude desktop app's connector command `ssh <box> rk mcp`) and the daemon's `/mcp` streamable-HTTP route (MCP clients already on the tailnet — Claude Code and kin). The CLI stays the single contract — every tool is exactly one verb invocation executed as an argv child process. The design authority is `docs/specs/mcp.md`; this file records the shipped state.

## Requirements

### Requirement: The policy table is the allowlist
`internal/mcp` SHALL define the `Row`/`Arg`/`ArgType`/`ResultKind`/`Annotations` types and the compiled-in package-level `Table []Row`; a verb with no row is not a tool. `ToolTimeoutCap` MUST be the single named constant `45 * time.Second`; a row with `Timeout == 0` uses the cap, and a row above it fails `Resolve`. A `neverTools` prefix list (`serve`, `daemon`, `remote`, `desktop`, `update`, `agent setup|hook`, `mux guard|init-conf`, `completion`, `shell-init`, `help-dump`, `skill`, `role`, `tutorial`, `cron tick`, `gui supervise|env`, `mcp`) MUST be rejected by `Resolve`.

#### Scenario: An unlisted verb is unreachable
- **GIVEN** the compiled `Table`
- **WHEN** an MCP client lists tools
- **THEN** exactly one tool per row appears, named by `Row.Tool`, and `kill`, `serve`, and `mcp` are absent

### Requirement: The drift guard resolves every row at startup
`Resolve(root, table)` MUST validate each row against the live Cobra tree, read-only: the `Path` resolves exactly (a partial `Find` is a miss); every `Flag` and flag-shaped `Literal` (`--json`; the `-` stdin marker and the `--` end-of-flags separator are exempt) exists via `LocalFlags()`/`InheritedFlags()` long-name and shorthand lookups; the pflag `Value.Type()` is compatible with the input type (`bool`⇔Boolean, `int`/`int64`⇔Integer, `string`/`duration`⇔String — a duration pflag is a string over the wire and the row carries the Go-duration pattern, `stringArray`/`stringSlice`/`skill`⇔StringArray — `skill` is riff's custom repeatable-flag pflag type); and duplicate tool names, a `Stdin` naming no string input of the row, a `Format` positional naming an input the row lacks, and an over-cap timeout are errors. Every error names the offending row (and flag). `Resolve` also validates the conditional model fields (`checkConditionals`): every `When` and `OneOf` member must name a non-literal input of the row; a `Default` rides only a string/integer `Flag` arg (never a Boolean, positional, or Literal) and an Integer default must parse; and an optional (non-required) stdin input must be a `OneOf` member (`checkStdin`). `cmd/rk/mcp_test.go` asserts `Resolve(rootCmd, Table)` succeeds, so a renamed or re-flagged verb fails `go test`, never the model; `rk mcp` re-runs the same resolution at startup and exits 1 with the same message.

#### Scenario: A renamed flag fails the build, not the model
- **GIVEN** a Cobra tree where `mux capture` lacks `-l`
- **WHEN** `Resolve` runs
- **THEN** the error names `capture` and `-l`

### Requirement: Schemas and descriptions derive from the row and the command
`InputSchema(resolved)` MUST return a JSON-schema object `{"type":"object","properties":{…},"required":[…],"additionalProperties":false}` where each property carries `type`, a `description` (the row's text, else the flag's pflag usage), and `pattern`/`enum`/`minimum`/`maximum`/`default` when set (a default is typed: a JSON number for Integer args, a string otherwise). An `ArgStringArray` input renders `{"type":"array","items":{"type":"string"}}` (plus `maxItems` when `Arg.MaxItems` is set). A schema-only input — an `Arg` with neither `Flag`, `Positional`, nor `Literal` and not named by `Stdin` — appears in the schema only to feed a `Format` positional (`tab_web`'s `window`/`slot`); a `Format` positional is itself anonymous (no input property) and renders its argv token from the named inputs: `{name}` substitutes the input's value (integers via `strconv.Itoa`), and a `[…]` optional segment is dropped when any input inside it is absent — a formatted positional whose required inputs are absent contributes nothing. The tool description MUST be `Row.Description` when set, else Cobra `Short` + blank line + `Long` trimmed — CLI help is never rewritten for the model. The handler validates raw arguments before anything execs (unknown property, missing required input, zero or two members of a row's `OneOf` set — a one-line message naming the inputs — wrong JSON type — including a non-array or non-string element for an array input, or a `MaxItems` overflow — pattern/enum/bounds violation ⇒ `IsError:true` with a one-line message) because the SDK's `Server.AddTool` does not validate raw schemas.

### Requirement: Tool calls exec the rk binary as argv under the row timeout
`Executor{Exe}.Run(ctx, argv, stdin, timeout)` MUST use `exec.CommandContext` under `context.WithTimeout` with a 2 s `cmd.WaitDelay` (a child that ignores the deadline kill cannot wedge the call), capture stdout and stderr separately, plumb `stdin` only when the row names a stdin input, and strip `TMUX`/`TMUX_PANE` from the child environment — no own-pane default may reach a tool. `BuildArgv` is a single ordered walk over `Args`: each flag, flag-shaped literal, positional (by slot order, which the seeded rows match), and bare literal is emitted where it sits in `Args`, so a row's `Args` order IS its argv order — the seeded rows are ordered to keep their argv byte-identical (capture still yields `mux capture -L s -l 100 %3 --json`; `board`'s flags still precede its positionals) while `gui_exec` places `--detach --json --` before its positionals; a string-array flag repeats (`--skill a --skill b`), a positional string array appends one argv element per item, and a `Format` positional renders its token from the named schema-only inputs; booleans map to a bare flag when true and nothing otherwise; an absent `Flag` input carrying a `Default` emits `flag Default` at its position; a `Literal` whose `When` input is absent is skipped; other absent optional inputs contribute nothing; every argv element is a separate slice entry — no joining, no quoting, no shell. `rk mcp` fills `Exe` with `os.Executable()`; tests point it at stubs.

#### Scenario: capture argv assembly
- **GIVEN** the `capture` row and a call `{server:"s", target:"%3", lines:100}`
- **WHEN** argv is built
- **THEN** it is `["mux","capture","-L","s","-l","100","%3","--json"]`

### Requirement: Results map by result kind
`MapResult` maps a subprocess outcome onto MCP content per the row's `ResultKind`:

- `ResultJSON` parses stdout in three tiers: **(a)** an object with a boolean `ok` key is the `--json` envelope — `ok:true` returns `result` re-serialised as one `TextContent`; `ok:false` maps `error.message` (+ `hint`/`reason` when present) to `IsError:true` — and the envelope wins even on a non-zero exit; **(b)** any other valid JSON document is the interim bare form, returned verbatim as one `TextContent` with `IsError` from the exit code; **(c)** non-JSON falls through to the text rule with a leading `(non-JSON output)` note. A non-zero exit without an envelope yields `IsError:true` with `{"code":"usage"|"operational","message":<stderr trimmed, else stdout>}` (exit 2 ⇒ `usage`).
- `ResultText` returns stdout verbatim (trailing newline trimmed) on exit 0 with `IsError:false`; otherwise `IsError:true` with `exit <n>: <stderr trimmed, else stdout>`.
- `ResultImage` parses stdout as an envelope first: an object with a boolean `ok` key is the `--json` envelope — `ok:false` maps to `mapEnvelope`'s error rendering with no file read and wins over a non-zero exit; `ok:true` reads `result.path` (missing or non-string ⇒ `IsError:true` naming the field), requires the 8-byte PNG signature at that path (no globbing, no other type), and returns `ImageContent{Data, MIMEType:"image/png"}` plus a `TextContent` carrying the `result` JSON re-serialized, so `width`/`height`/`scale`/`display` reach the model. Non-envelope stdout keeps the interim form: a non-zero exit is the text rule; otherwise the first non-empty line is the path and the text payload is `{"path":"<p>"}`. Unit-tested against a temp PNG in `result_test.go` (no X display in CI). (260911-ehm2-cli-json-read-verbs)
- A `TimedOut` outcome on any kind yields `IsError:true` with `{"code":"operational","reason":"timeout","message":"<tool> exceeded <timeout>"}`.

### Requirement: The seeded table ships twenty-nine tools
`Table` MUST seed exactly these twenty-nine rows, in this order. Nine read-only (`ResultJSON`, annotations `readOnlyHint:true, destructiveHint:false, idempotentHint:true, openWorldHint:false`), each with a `--json` literal and — where the verb accepts it — an optional `server` input mapped to `-L`: `sessions` (`mux sessions`, optional `all` boolean), `panes` (`mux panes`), `capture` (`mux capture`; `lines` integer bounded 1–2000; required `target` matching `^(%\d+|@\d+|=.+:.+)$`), `process` (`mux process`), `status` (`status`), `cron_list` (`cron list`), `gui_status` (`gui status`), `tab_show` (`tab show`; required `window` matching `^@\d+$`), `tab_web_ls` (`tab web ls`) — plus, after `await`, two more read-only rows: `snapshot_list` (`mux snapshot list`, `ResultJSON`) and `gui_shot` (`gui shot`, the one `ResultImage` row, last in the table). One mutating row: `send` (`mux send`, `ResultJSON` behind the verb's `--json` envelope receipt, all annotations false, required `message` streamed on stdin behind the `-` literal, a trailing `--json` literal). One action-enum row: `board` (`Path:"board"`, `ResultJSON`, all-false annotations — a mixed read/write tool carries no hint), with args in order `server` (`-L`); `action` (positional 1, required, enum `show|pin|unpin|reorder`); `name` (positional 2, optional, pattern `^[A-Za-z0-9_-]{1,32}$`); `window` (positional 3, optional, pattern `^@\d+$`); `before`/`after` (flags, pattern `^@\d+$`); the `--json` literal. `BuildArgv` for a reorder call `{action:"reorder", name:"work", window:"@7", after:"@3", server:"s"}` yields `["board","-L","s","--after","@3","reorder","work","@7","--json"]`, which Cobra parses on the `reorder` child because the flags are persistent on the parent (§ Design Decisions). Seven rows carry description overrides: `status` (the verb hard-codes the `runkit` server and its help does not say so), `send` (`sendDescription` — names the receipt fields `report`/`target`/`server`/`enter`, keeps the caveat that `delivered` does NOT mean the agent has acted on it, points at `await` to wait for the agent's state and `capture` to read the pane, names the three failure `reason` tokens with what each asks the caller to do, and says `--force` is not exposed and `--answer`/`--key` live on `answer`), `answer` (`answerDescription` — the message-vs-key split, a bare key press riding the plain gate column, the receipt words), `await` (`awaitDescription` — the report words, `running` means call again, the `ready`/`parked`/`narrow` boot-readiness verdicts, `until`/`ready` exclusivity), `board` (`boardDescription` — the family `Long` is terminal prose, so the row names each action's required inputs, the `default` server for the mutations, the reorder-only `@N` neighbours, and the route-body / `{board, window, orderKey?}` receipt shapes), `snapshot_list` (the verb has no `Long` of its own and the parent's help describes the unexposed `show`/`restore` subcommands), and `gui_shot` (the verb's `Long` promises a bare path on stdout and names flags the tool does not expose). The `send`/`answer`/`await` rows are argv doors onto the messaging verbs documented in [agent-messaging](/run-kit/agent-messaging.md). The shape is pinned by `TestTableShape` (the twenty-nine names in table order), `TestTableSendRow`, `TestTableAnswerRow` (the message/key one-of, the closed key enum, the `When`-gated literals), `TestTableAwaitRow` (the `until` pattern, the 1–40 timeout bounds with `Default "40"`, `readOnlyAnn`), `TestTableBoardRow` (args, enum, patterns, annotations, description), `TestMCPBoardSchema` (the resolved schema: only `action` required, the four-value enum, the three patterns, no read-only hint), the `TestBuildArgvBoardActionEnum` argv case, and the E2E want-list.

The `operator_request` row (after `board`, before `snapshot_list`) is (`operator request`, `ResultJSON`, all-false annotations — a Talk row): a required `template` positional carrying the closed 9-id enum `operatorTemplateIDs` (mirrored in `policy.go` because `internal/mcp` cannot import `rk/api` — the daemon's `/mcp` route would close the cycle — and pinned to `api.OperatorTemplateList()` by `cmd/rk`'s `TestOperatorRequestEnumMatchesRegistry`), optional `--window` (`^@\d+$`), `--text`, and `--session` flags, the `-L` server input, a trailing `--json` literal, and a description override naming the window-scoped templates (`fix-tab-name`, `annotate-tab`, `user-message`), the `text`/`session` acceptors, and the `queued:true` meaning. (sjs1)

The two rows added for the JSON-read-verbs envelope carry their own input shapes: `snapshot_list` exposes an optional positional-1 `server` string matching `^[a-zA-Z0-9_-]{1,64}$` (mirroring `ValidateServerName`) and no `-L` input — the verb rejects the inherited flag at runtime while the drift guard would still resolve it, so the positional filter is the only server input; `gui_shot` exposes only `max_width` (`--max-width`, integer, minimum 1) — `--scale` (float64) and `--window` (uint64) sit outside the drift guard's type set and `--out` is a filesystem path outside the target rule, so the proxy returns the PNG bytes. (260911-ehm2-cli-json-read-verbs)

The final two rows, appended after `operator_request`, are the messaging pair (260911-i2vm-cli-send-await-receipts). `answer` (`mux send`, `ResultJSON`, all-false annotations — a Talk row): an optional `message` (string, the `Stdin` input) and an optional `key` (`--key`, string, the closed enum `Enter Escape Tab Up Down Left Right Space BSpace y n 1 2 3 4 5 6 7 8 9` — control chords excluded), the literals `--answer` and `-` gated on `When:"message"` so a bare key press rides the plain gate column (a `waiting` agent refuses it), `OneOf:[message,key]` enforced by `ValidateArgs` before exec, and the `--json` literal; the receipt is the send receipt — `report:"delivered"` with `enter:true` for a message, `report:"sent"` with `enter:false` for a key. `await` (`mux await`, `ResultJSON`, `readOnlyAnn` — read-only even though it blocks; `Timeout` 0 ⇒ the cap): `until` (`--until`, pattern `^(idle|waiting|active)(,(idle|waiting|active)){0,2}$`), `timeout` (`--timeout`, integer bounded 1–40 with `Default "40"` emitted when absent — the structural clamp that keeps the verb reporting `running` before the 45 s proxy deadline, surfaced as the JSON-schema `default`), `ready` (`--ready`, boolean), and the `--json` literal; `--any`, `--file`, `--after-active`, and `--notify` are not exposed.

Thirteen mutating rows follow `gui_shot`, in table order `notify`, `riff`, `new_window`, `operator`, `cron_add`, `tab_layout`, `tab_web`, `tab_code`, `code_exec`, `gui_exec`, `kill`, `cron_rm`, `cron_mute` — each `ResultJSON` with a trailing `--json` literal (so the parser's envelope tier (a) maps the receipt the verb emits) and the 45 s timeout cap unless stated:

- `notify` (`notify`): required `message` positional; `title` (`--title`). No annotations.
- `riff` (`riff`): **required** `server` (`-L`, pattern `^[A-Za-z0-9_-]+$`) and `repo` (`--repo`, an absolute git-toplevel path) — the executor strips `$TMUX` and its cwd is not the repo, so the verb's own defaults are unreachable (§ Design Decisions); `session` (`--session`, `^=.+$`); `preset` (positional 1); `skill` (`--skill`, **string array** — the repeated-flag mapping); `layout` (`--layout`); `count` (`-N`, integer 1–8). **No `--cmd`** (a pane shell command is a shell string).
- `new_window` (`tab new`): `server`, `session` (`^=.+$`), `cwd`, `name`, `layout` — no `--ready`, no `-- CMD`; the window is born idle. The verb's `{session, session_rung, window_id, pane_id}` document rides the envelope inside `result` like the sibling rows; the always-present `session_rung` says why the landing session was chosen, and over MCP a call that omits `session` reads `server` — the executor strips `TMUX`/`TMUX_PANE`, so there is no caller session and the role-aware ladder is unreachable; an explicit `session` input still returns the `explicit` rung (xga4). The row's description override states that shape and the infra-caller rule.
- `operator` (`operator`): **required** `server` (`-L` — the verb refuses without `$TMUX` otherwise, and the executor strips `$TMUX`); `workers` (`--workers`, `^[A-Za-z0-9_-]+$`). **Idempotent**.
- `cron_add` (`cron add`): required `prompt` positional; `every`/`idle_every`/`min`/`max` (Go-duration pattern `^[0-9]+(ns|us|µs|ms|s|m|h)([0-9]+(ns|us|µs|ms|s|m|h))*$` — the shared `goDurationPattern`); `backoff` (bool); `cron` (`--cron`); `catch_up` (enum `once`); `name`; `deliver` (enum `immediate|when-idle|skip-if-busy`); `if_absent` (enum `skip|notify`); `pinned` (bool); `role`, `pane` (`^%\d+$`), `session` (`--role`/`--pane`/`--session`). `--respawn` (a string array that is an argv) and `if-absent respawn` are **not exposed**.
- `tab_layout` (`tab layout`): required `window` positional (`^@\d+$`); `layout` (positional 2 — the set form: the tree form `h(tty,v(code,web))` or a legacy `<shape>:<surface,…>` preset string; omitted is a read); `add`/`rm`/`promote` (enum `tty|web|code|gui` — add splits the last tile along its longer axis, rm's neighbours absorb the space, promote swaps with slot A); `cycle` (bool — the next template for the tile count). Every form prints the tree form of the resulting layout.
- `tab_web` (`tab web`): the second action-enum row, the `board` shape — `action` positional 1 (required, enum `add|rm|select|mv`) on the parent path with `--show`/`--json` persistent on the parent; `window` (required, `^@\d+$`) and `slot` (integer 1–`tmux.MaxWebTabs`) are schema-only inputs feeding one **formatted positional** (`Format: "{window}[/web/{slot}]"` at positional 2 — the bracketed segment drops when `slot` is absent); `target` (positional 3 — add's target); `to` (positional 4, integer — mv's destination); `show` (bool, add only). argv per action: `tab web add @N <target> [--show] --json` · `tab web rm @N/web/<slot> --json` · `tab web select @N/web/<slot> --json` · `tab web mv @N/web/<slot> <to> --json`; per-action required-ness (`target` for add, `slot` for rm/select/mv, `to` for mv) is enforced by the verb's own usage errors, exactly how `board` handles `name`/`window`.
- `tab_code` (`tab code set`): `server`; required `window` positional; required `folder` positional 2 (the verb validates existence).
- `code_exec` (`code exec`): required `command` positional; `args` (positional 2, **string array** — each element one argv element); `host`, `tab` (`^@\d+$`), `folder`, `timeout` (duration pattern), `all` (bool). Policy row only — the verb's existing raw response envelope rides parser tier (b).
- `gui_exec` (`gui exec`): literals `--detach`, `--json`, `--` emitted before the positionals by the ordered walk (argv `gui exec --detach --json -- <command> <args…>`); required `command` positional; `args` (positional string array). Always detached — the receipt is `{pid, display}`, never the command's output.
- `kill` (`mux kill`): required `target` positional (`^(%\d+|@\d+|=.+:.+)$`). **Destructive**; **no `--force`** (the banned-flag loop test-pins it).
- `cron_rm` (`cron rm`): required `id` positional. **Destructive**.
- `cron_mute` (`cron mute`): required `id` positional; `for` (`--for`, duration pattern); `off` (bool). **Idempotent**.

Eight of the thirteen carry description overrides because Cobra help written for a terminal misleads a model on them: `tab_web` (which inputs each action requires — the `board` description's pattern), `riff` (`server`/`repo` required over MCP, `skill` items are slash commands rendered for the resolved provider, no `--cmd`, and the receipt's `panes[0]` is the task pane), `new_window` (born idle; how `session`/`cwd` default; the result shape), `operator` (idempotent — `created:false` means an operator already existed on that server), `cron_add` (the prompt is text typed into an agent, never a command; exactly one schedule input and exactly one of `role`/`pane`/`session` are required), `gui_exec` (always detached; pair with `gui_status`/`gui_shot`), `kill` (gated on agent state and server protection; a refusal is the verb's error, and there is no force path over MCP), and `notify` (`delivered:false` is not an error — the verb is fail-silent by contract). No row exposes `--force`, `--cmd`, `--respawn`, or `--ready`. (260911-fr5t-cli-spawn-and-steer-receipts)

### Requirement: `rk mcp` serves the SDK server over stdio
`rk mcp` MUST be a visible root verb (`cmd/rk/mcp.go`, registered after `skillCmd`) taking no arguments (`usageArgs(cobra.NoArgs)`, `SilenceUsage`), with stdout reserved for the protocol and all diagnostics on stderr via an `slog` text handler. `runMCP` passes the Cobra root (introspected, never executed), `os.Executable()`, `displayVersion()`, and the instructions — the core skill bundle bytes verbatim, byte-identical to `rk skill`'s output (topic pages are content, not tools; the bundle itself is unchanged) — into `mcp.New`, then serves `RunStdio` under a SIGINT/SIGTERM-cancelled context. The wire protocol is owned by the pinned `github.com/modelcontextprotocol/go-sdk v1.7.0` (imported under the `mcpsdk` alias; it pulls `github.com/google/jsonschema-go` indirectly) — run-kit writes no protocol code. The server holds no state beyond the SDK session, and the tool list is static for the process life (no `listChanged`). Nothing in `internal/mcp` assumes a transport — `rk mcp` serves the server over stdio (`RunStdio`) and the daemon's `/mcp` route serves the same instance over streamable HTTP (`HTTPHandler`).

### Requirement: The daemon mounts the same server over streamable HTTP at `/mcp`
`(*Server).HTTPHandler(policy OriginPolicy, logger *slog.Logger) http.Handler` (`internal/mcp/http.go`) MUST return `mcpsdk.NewStreamableHTTPHandler(getServer, opts)` — `getServer` answering `s.sdk` for every request, so every session shares the one policy table and executor — wrapped by the Origin guard. `HTTPRoutePath` MUST be `"/mcp"` and `HTTPSessionIdleTimeout` MUST be `30 * time.Minute`. The options are stateful (`Stateless` false — the `GET` SSE stream and `DELETE` termination exist only in stateful mode; stateless answers them 405), SSE responses (`JSONResponse` false, the SDK default), no `EventStore` (no stream resumption), `CrossOriginProtection` nil (deprecated, and its `Origin == Host` fail-open is the reference the spec forbids), `DisableLocalhostProtection` false (the SDK's loopback-arrival/non-loopback-`Host` 403 is an additive guard that never trips a tailnet request, which arrives on the tailnet address). Per-session state lives inside the SDK handler for the session's life only, bounded by the idle timeout (Constitution II — the handler's memory is the only state). `rk serve` wires the mount fail-soft via `wireMCP` (`cmd/rk/serve.go` — a named function taking the root via `cmd.Root()` rather than the `rootCmd` package var, because `rootCmd`'s no-args default delegates to `serveCmd.RunE` and a var reference back would be an initialization cycle): an `mcp.New` failure logs `mcp: /mcp disabled — policy table did not resolve` at WARN and leaves the route answering 503 (the daemon must still come up — availability first); success logs `mcp: /mcp mounted` with `tools` and `origins` at INFO and calls `apiServer.SetMCPHandler(server.HTTPHandler(policy, logger))`. `Exe` is `os.Executable()` for parity with `rk mcp` — every upgrade path restarts the daemon, so the running binary's own path is the right verb executable for its lifetime. (260911-cl9j-mcp-http-route)

#### Scenario: a vanished client cannot hold its session forever
- **GIVEN** a client that connected over `/mcp` and never sent `DELETE`
- **WHEN** no HTTP request arrives for `HTTPSessionIdleTimeout`
- **THEN** the SDK closes the session and frees its state

### Requirement: The Origin allowlist is the transport's DNS-rebinding guard
`originGuard` MUST wrap the SDK handler and apply to EVERY method, including the `GET` SSE stream. A request with no `Origin` header is not a browser request and always passes; the request `Host` header is never consulted — under DNS rebinding both headers carry the attacker's name. A present `Origin` MUST satisfy `OriginPolicy.Allows` or be rejected with `403`, `Content-Type: application/json`, body `{"error":"origin not allowed"}`, plus exactly one WARN log line (`mcp: origin rejected`, naming the origin). `NewOriginPolicy(origins []string)` normalizes each entry and drops non-origins; `Origins() []string` returns the sorted allowlist for logging and the doctor/test surface. `Allows` shares `normalizeOrigin` with the constructor: `url.Parse`; reject anything with a path, query, fragment, or userinfo, or a scheme other than `http`/`https`; scheme and host lowercased; a missing port filled with the scheme default (`80`/`443`) so `http://box` and `http://box:80` compare equal; IPv6 hosts bracketed. The loopback exception passes any origin whose host is `localhost`, a `127.0.0.0/8` address, or `[::1]` at any port and either scheme — rebinding cannot manufacture a loopback origin, and same-box clients legitimately run on other ports (the Vite dev rig, an `rk remote` tunnel client). Otherwise an exact `scheme://host:port` entry is required. (260911-cl9j-mcp-http-route)

#### Scenario: the rebinding shape is rejected
- **GIVEN** a policy built from `["http://box:3000"]`
- **WHEN** a request arrives with `Origin: http://evil.example:3000` and `Host: evil.example:3000` (Origin equals Host)
- **THEN** it is rejected with `403 {"error":"origin not allowed"}` and one WARN line
- **AND** a request with `Origin: http://box:3000` and an unrelated `Host` passes to the SDK handler

### Requirement: The allowlist derives once from the daemon's own identity
`DeriveAllowedOrigins(bindHost string, port int, hostname string, addrs []net.Addr, tailnet TailnetIdentity) []string` MUST return deduplicated, sorted `http://<host>:<port>` entries for: `bindHost` unless unspecified (`0.0.0.0`, `::`, `[::]`, empty — a wildcard bind names no origin; the interface enumeration covers the concrete addresses); `hostname` lowercased and, when qualified, its first DNS label (MagicDNS resolves the short name via the tailnet search domain, so browsers may send either form); every global-unicast IP in `addrs` (`*net.IPNet` or `*net.IPAddr`; loopback, link-local, and multicast excluded; IPv6 bracketed via `net.JoinHostPort`); `tailnet.DNSName` with any trailing dot removed; and each `tailnet.IPs` entry. Entries are `http` only — the daemon serves plain HTTP. `LiveTailnetIdentity(ctx) TailnetIdentity` MUST gate on `exec.LookPath("tailscale")`, then run `tailscale status --json` via `exec.CommandContext` under `tailscaleProbeTimeout` (3 s) with an argv slice, reading `Self.DNSName` + `Self.TailscaleIPs`; a missing binary, non-zero exit, timeout, or unparseable output yields the zero `TailnetIdentity{DNSName, IPs}`, logged at DEBUG only — the route never depends on tailscale being installed. The set is computed ONCE at daemon start (`wireMCP` gathers `cfg.Host`, `cfg.Port`, `os.Hostname()`, `net.InterfaceAddrs()`, and the probe) — the daemon's own addresses are startup facts; a restart is the way they change. (260911-cl9j-mcp-http-route)

#### Scenario: derivation skips the wildcard bind and the junk addresses
- **GIVEN** `bindHost "0.0.0.0"`, `port 3000`, `hostname "Box.tail1234.ts.net"`, addrs `{127.0.0.1/8, 100.64.1.2/32, fe80::1/64}`, tailnet `{DNSName:"box.tail1234.ts.net.", IPs:["100.64.1.2"]}`
- **WHEN** `DeriveAllowedOrigins` runs
- **THEN** the result is exactly `http://100.64.1.2:3000`, `http://box.tail1234.ts.net:3000`, `http://box:3000` — no wildcard, loopback, link-local, or duplicate tailnet entry

### Requirement: `rk doctor` carries the `mcp route` row
`rk doctor` MUST include an `mcp route` row immediately after the `mcp` drift-guard row, built by the pure `mcpRouteCheck(origin string, tools int, get func(url string) (int, string, error)) doctorCheck` over an injected probe so tests never dial. The row is a STATE row — always `OK: true` with a `Note`, never flipping the verdict (a stopped or pre-route daemon is a state, not a dependency failure; the `mcp` row above remains the verdict flipper), and it appears in `--json` like every check. The live wrapper `mcpRouteDoctorCheck(ctx, tools)` probes `<resolveOrigin(ctx)>/mcp` through the package-level `doctorHTTPGet` seam (the `dialTCP` idiom): a session-less `GET` with `Accept: text/event-stream`, no session header, `http.Client{Timeout: doctorMCPClientTimeout}` (2 s), body read capped at `doctorMCPBodyCap` (1 KiB — the probe keys on the status; the body is diagnostic only). The SDK's stateful handler answers a session-less `GET` with `400 ("GET requires an Mcp-Session-Id header")` — the positive signature; the probe opens no MCP session. Notes: probe error → `not reachable at <origin>/mcp — is the daemon running? (rk daemon start)`; `404` → `daemon at <origin> answers 404 for /mcp — it predates the route; restart it (rk daemon restart)`; `503` → `route present but the transport is not configured — the daemon logged why at start (see the mcp row above)`; `400`, `405`, or any `2xx` → `mounted at <origin>/mcp` plus ` (<n> tools)` quoted from the drift-guard row's resolution (0 when it failed, dropping the suffix); any other status → `unexpected <status> from <origin>/mcp`. (260911-cl9j-mcp-http-route)

#### Scenario: a session-less GET is the mounted signature
- **GIVEN** a daemon serving `/mcp` and a probe answering `(400, "Bad Request: GET requires an Mcp-Session-Id header", nil)` with 10 tools resolved
- **WHEN** `mcpRouteCheck` runs
- **THEN** the row is `OK: true` with Note `mounted at http://127.0.0.1:3000/mcp (10 tools)` and the overall verdict is unaffected

### Requirement: `rk url --mcp` prints the MCP endpoint
`urlCmd` MUST carry a local bool flag `--mcp` ("Print the MCP streamable-HTTP endpoint (<url>/mcp) instead of the server root"): with the flag, stdout is exactly `resolveOrigin(ctx) + mcp.HTTPRoutePath` newline-terminated, exit 0, empty stderr; without it the output is byte-identical to the bare form. The `Long` names the flag's consumer — the endpoint an MCP client on the tailnet (Claude Code and kin) is pointed at; the Claude desktop app uses `ssh <box> rk mcp` instead. `Args: cobra.NoArgs` is unchanged, and the same heuristic caveat applies (what the server WOULD bind, not a liveness probe). `help-dump` publishes the flag automatically via the tree walk; the skill bundle is unchanged. (260911-cl9j-mcp-http-route)

### Requirement: `rk doctor` carries the `mcp` row
`rk doctor` MUST include an `mcp` row (`mcpDoctorCheck` → in-process `mcp.Resolve(rootCmd, mcp.Table)` — introspection only, no exec, no tmux): success ⇒ OK with note `29 tools; all policy rows resolve` (the count derives from the resolved table — `mcpCheck(len(resolved))`, so it tracks `len(Table)`); failure ⇒ FAIL with the `Resolve` error as the hint. A table that cannot resolve is a defect, so unlike the always-OK state rows this row flips the verdict. The row appears in `--json` like every other check.

### Requirement: The E2E test drives the real binary with a real MCP client
`cmd/rk/mcp_e2e_test.go` MUST skip unless `tmux` and `go` are on PATH, `go build` a real `rk` into `t.TempDir()`, start an isolated `rk-test-mcp-<pid>-<ns>` tmux server with one session `boot` (the [test-sockets](/run-kit/test-sockets.md) isolation recipe — `t.Cleanup` kill-server, `TestMain` residue sweep), and connect a go-sdk client over `CommandTransport` with `TMUX`/`TMUX_PANE` (and `RK_HOST`/`RK_PORT`) unset in the child environment — plus a temp `XDG_STATE_HOME` and `RK_HOST=127.0.0.1`/`RK_PORT=1`, so the cron tools write under the temp dir and `notify` resolves to a refused loopback port. It asserts the twenty-nine tool names (the want-list includes rows the E2E lists but never calls: `board` and `operator_request` need a running daemon, which that harness does not start; `riff`, `operator`, `gui_exec`, and `code_exec` are unit-tested only — they need `wt`/fab/an X display/a code-server host), the read-only annotations (`sessions`/`capture`/`await`), `capture`'s required/bounded inputs, the `answer` key enum and `await`'s timeout bounds/default in the resolved schemas, the `send` description phrase, and `instructions == docs/site/skill.md` bytes; then calls `sessions` (a row named `boot`), `send` (`echo MCP_E2E_OK` ⇒ the text block parsed as JSON with `report:"delivered"`, `target` the pane, `enter:true`), `answer` (`key:"Enter"` on the uninstrumented shell pane ⇒ `report:"sent"`, `enter:false`), `await` (`timeout:1` on the shell pane ⇒ `IsError` — the verb's nothing-observable diagnostic passes through as an operational error), and a polled `capture` until the JSON `content` carries `MCP_E2E_OK`; negative cases cover a schema rejection (`target:"bogus"`), a verb stderr pass-through (`%999`), the closed key enum (`key:"C-c"` rejected before exec), and the `answer` one-of (both and neither payload rejected). Two mutating loops then drive the isolated server with each receipt's ids chaining into the next call: `new_window` (session `=boot`) → `tab_layout` (`layout:"split-h:tty,web"`) → `tab_web` (`action:"add"`, target `https://example.com`) → `kill` (the new window's pane — the receipt carries `report:"killed"`, and the created window is gone afterwards), and `cron_add` (`prompt`, `every:"1h"`, `role:"operator"`) → `cron_mute` (`for:"30m"` — the receipt carries the lease's `until`) → `cron_rm` (`removed:true`), the `id` chaining across the three receipts; `notify` returns `{"delivered":false}` with no daemon, `IsError:false`. Write` (one session, one window), and a live `snapshot_list` call asserts the single row round-trips through the envelope — server name, session/window counts, and an explicit `died_at: null` for the live entry; `gui_shot` stays unit-tested in `result_test. `Close()` ends the server process. It runs under `just test-backend`.

### Scope: what the surface does not ship
Every allowlist-v1 row has a policy row except `present` (tier two — no row); `mux new` emits a `--json` receipt but has no row (the allowlist names no `mux new` tool). `/mcp` carries no `EventStore` (no stream resumption), no `listChanged`, and no MCP resources or prompts; `https` allowlist entries for a TLS-terminating proxy in front of the daemon (e.g. `tailscale serve`) are not derived — the daemon serves plain HTTP and the spec defines no config key for one. Sequencing lives in `fab/plans/sahil/26-09-10-rk-mcp.md` (waves W2–W3). (260910-nuf6-rk-mcp-stdio) (260911-cl9j-mcp-http-route) (sjs1) (260911-i2vm-cli-send-await-receipts) (260911-ehm2-cli-json-read-verbs) (260911-fr5t-cli-spawn-and-steer-receipts)

## Design Decisions

### Action-enum policy rows require their flags on the parent command
**Decision**: `-L`, `--json`, `--before`, `--after` are persistent flags on `boardCmd`; children that do not use `--before`/`--after` reject them at run time as usage. `tab_web` uses the same placement — `--show`/`--json` are persistent on `tabWebCmd`, and the mutations that do not take `--show` reject it at run time as usage.
**Why**: `mcp.Resolve` looks flags up on the row's `Path` (the parent), and `BuildArgv` emits each arg where it sits in `Args` (the `board` row's flags sit first, so the argv stays `rk board -L s --after @3 reorder work @7 --json`), so every flag the row uses must parse on every child.
**Rejected**: a single leaf `board <action> …` command (loses per-verb help and contradicts the spec's "family like `tab`"); defining `--before`/`--after` on `reorder` only (fails the drift guard at startup).
*Introduced by*: 260911-u49l-rk-board-verb

### Three-tier `ResultJSON` parser
**Decision**: envelope (object with boolean `ok`) → bare JSON (interim) → text fallback.
**Why**: tier (b) keeps a verb's interim bare document readable and the proxy unchanged when the verb graduates to the `--json` envelope.
**Rejected**: `ResultText` for all seeded rows (loses `isError` from `ok:false` once envelopes land; forces a proxy edit per verb at graduation).
*Introduced by*: 260910-nuf6-rk-mcp-stdio

### Injectable `Executor.Exe`
**Decision**: the rk binary path is a field; `rk mcp` fills `os.Executable()`.
**Why**: executor and result tests run against shell stubs; the daemon's `/mcp` route constructs the same executor.
**Rejected**: hard-coding `os.Executable()` inside the executor (untestable without a built binary).
*Introduced by*: 260910-nuf6-rk-mcp-stdio

### E2E builds the real binary
**Decision**: `go build` into `t.TempDir()` inside the E2E test.
**Why**: the server child calls `os.Executable()` per tool; re-exec-ing the test binary (the RK_RIFF_SUBPROC pattern) would route tool calls into the test runner.
**Rejected**: test-binary re-exec with an env guard; a `just` recipe that pre-builds (couples the test to the runner).
*Introduced by*: 260910-nuf6-rk-mcp-stdio

### Children run without `TMUX`/`TMUX_PANE`
**Decision**: the executor strips both from the child environment.
**Why**: the target rule — no own-pane default may reach a tool; an `ssh` session started inside tmux would otherwise leak one.
**Rejected**: relying on the schema alone (a verb with an optional target could still resolve the leaked pane).
*Introduced by*: 260910-nuf6-rk-mcp-stdio

### Own Origin guard over the SDK's and Go's cross-origin protection
**Decision**: `/mcp` is wrapped by the `internal/mcp` `OriginPolicy` allowlist middleware; `StreamableHTTPOptions.CrossOriginProtection` stays nil and Go's `http.CrossOriginProtection` is not used.
**Why**: `docs/specs/mcp.md` § Transports names `Origin == Host` as defending nothing under DNS rebinding; both the SDK option (deprecated) and Go's `Check` pass on exactly that comparison, and Go's exempts `GET` — which is the SSE stream.
**Rejected**: `http.NewCrossOriginProtection()` with `AddTrustedOrigin` (still falls open on `Origin == Host` before consulting the trusted set); the SDK's `enableoriginverification` debug knob (same fail-open, and a `MCPGODEBUG` env is not a design).
*Introduced by*: 260911-cl9j-mcp-http-route

### Stateful transport with an idle-session timeout
**Decision**: `Stateless: false`, `SessionTimeout: HTTPSessionIdleTimeout` (30 min), no `EventStore`.
**Why**: the spec's `GET` SSE stream and `DELETE` termination exist only in stateful mode; the SDK never closes idle sessions by default, so a vanished client would hold memory forever (Constitution II — the handler's memory is the only state).
**Rejected**: stateless mode (answers 405 to `GET`/`DELETE`, contradicting `docs/specs/api.md` § MCP); no timeout (unbounded per-session memory).
*Introduced by*: 260911-cl9j-mcp-http-route

### Setter-injected handler; the route is always registered
**Decision**: `api.Server.SetMCPHandler` carries the handler across the `cmd/rk` → `api` boundary; `/mcp` is registered unconditionally and answers `503 {"error":"mcp transport not configured"}` until set.
**Why**: `api` cannot import `cmd/rk`'s `rootCmd`; the setter mirrors `SetVersion`/`SetUpdateChecker`; an unregistered route would fall to the SPA catch-all's 404, indistinguishable from a pre-route daemon for the doctor `mcp route` row.
**Rejected**: passing the handler into `NewRouterAndServer` (signature churn for `NewRouter` callers and tests); building the MCP server inside `api` (needs the Cobra tree).
*Introduced by*: 260911-cl9j-mcp-http-route

### Allowlist derived once at start
**Decision**: `DeriveAllowedOrigins` folds the bind host, `os.Hostname()`, `net.InterfaceAddrs()`, and a best-effort `tailscale status --json` self-identity into `http://…:<RK_PORT>` entries at daemon start.
**Why**: the spec names the tailnet hostname and IP as inputs without a derivation; interface enumeration yields the tailnet IP without the binary, and only the MagicDNS FQDN needs the bounded probe; the daemon's own addresses are startup facts.
**Rejected**: a config key listing origins (Constitution VII — convention over configuration; the spec defines none); re-deriving per request (a subprocess on the hot path).
*Introduced by*: 260911-cl9j-mcp-http-route

### The doctor route row keys on the SDK's session-less 400
**Decision**: `mcp route` is always `OK: true`; a bare `GET /mcp` answering `400 … Mcp-Session-Id` is the mounted signature.
**Why**: the `code-server`/`gui` rows set the posture that a not-running or older daemon is a state, not a dependency failure; the `mcp` drift-guard row remains the verdict flipper for real defects; the probe opens no MCP session.
**Rejected**: a full `initialize` handshake (heavier, and leaves a session to `DELETE`); a verdict-flipping row (a stopped daemon would fail doctor).
*Introduced by*: 260911-cl9j-mcp-http-route

### No full-daemon E2E for the transport
**Decision**: `/mcp` is tested with `httptest.NewServer` plus the SDK's real `StreamableClientTransport` against the stub executor, plus router-level and doctor-level unit tests; no test starts `rk serve`.
**Why**: the httptest handler is the exact handler the daemon mounts; starting `rk serve` in a test would drag in the collectors, the tmuxctl supervisor, and a port for no additional coverage of this surface.
**Rejected**: a full-daemon E2E (a heavyweight harness covering wiring the unit tests already assert).
*Introduced by*: 260911-cl9j-mcp-http-route

### The Constitution IX exception lives in the constitution text
**Decision**: the scoped `/mcp` `POST`+`GET`+`DELETE` exception is recorded in `fab/project/constitution.md` § IX itself (version 1.12.0), not only in the specs.
**Why**: a literal reading of IX (`PUT`, `PATCH`, and `DELETE` SHALL NOT be used) otherwise contradicts the merged design in `docs/specs/mcp.md` § Transports and `docs/specs/api.md` § MCP; the recorded exception is transport-scoped, grants nothing to `/api/*`, and leaves the CORS allowlist at `[GET, POST, OPTIONS]`.
**Rejected**: spec-only recording (the constitution stayed literally inconsistent with the specs it governs).
*Introduced by*: 260911-cl9j-mcp-http-route

### Template enum mirrored in `internal/mcp`, pinned by a `cmd/rk` test
**Decision**: `operatorTemplateIDs` is hard-coded in `policy.go`; `cmd/rk/mcp_test.go` asserts it equals the ids of `api.OperatorTemplateList()`.
**Why**: `internal/mcp` must not import `rk/api` — the daemon's `/mcp` route mounts `mcp` inside `api` (`api → mcp`), so `mcp → api` would close an import cycle. A closed enum gives the model the template set in-schema.
**Rejected**: a free-form pattern with verb-side rejection (the model would guess ids); a registration hook from `api` into `mcp` at init (hidden coupling).
*Introduced by*: 260911-sjs1-rk-operator-request-verb

### Receipts derive from the report word, not the engine
**Decision**: `runMuxSend` builds the `--json` receipt from the `report` variable it already computes plus the sentinel error type it already branches on; `inject.Engine.Send` still returns only `error`.
**Why**: the spec fixes `result` to `report`/`target`/`server`/`enter`, all derivable in the verb; the CLI-single-contract rule and the agent-messaging evidence vocabulary forbid a second source.
**Rejected**: returning an evidence struct from the engine (touches the daemon's `/send` adapter for no consumer).
*Introduced by*: 260911-i2vm-cli-send-await-receipts

### Structural 40 s clamp via a schema default
**Decision**: the `await` tool's `timeout` input is bounded 1–40 with the policy-row `Default "40"` emitted as `--timeout 40` when absent; `Arg.Default` is a generic field surfaced as the JSON-schema `default`.
**Why**: an absent `--timeout` means 300 s, which would hit the proxy backstop and report a timeout error instead of the spec's `running` + `call again`.
**Rejected**: a runtime clamp in the server handler (a second place that knows the cap); making `timeout` required (a worse model UX).
*Introduced by*: 260911-i2vm-cli-send-await-receipts

### Conditional literals and one-of live in the policy model
**Decision**: `Arg.When` gates a literal on an input's presence; `Row.OneOf` is validated by `ValidateArgs` before exec.
**Why**: `answer` is one tool covering `--answer <message>` and `--key <k>`; the verb's payload-XOR would also reject bad calls, but the model should see the schema-level message first, and the same one-of shape serves later rows with alternative target inputs.
**Rejected**: two tools (`answer` + `key`) — the spec names one and forbids more action enums; a hand-written handler for `answer` (breaks the mechanical-proxy rule).
*Introduced by*: 260911-i2vm-cli-send-await-receipts

### `gone` is `ok:false` under the envelope
**Decision**: under `--json`, `gone` (exit 1) is an error document with `reason:"gone"`; for `send --await` the delivered fact rides the hint.
**Why**: the envelope's "`ok` mirrors the exit code" rule is normative and the exit code is 1.
**Rejected**: `ok:true` with `report:"gone"` (would break the exit-code mirror).
*Introduced by*: 260911-i2vm-cli-send-await-receipts

### Success receipts via `JSONResult`; failure envelopes via `execute()`
**Decision**: a mutating verb under `--json` calls `sink.JSONResult(receipt)` on its success path only; every `return err` gets its `{"ok":false,"error":{…}}` document from `execute()`'s central `jsonErrorEnvelope` writer (a `--json` command that wrote nothing to stdout), so no verb hand-formats an envelope at any return. The two verbs that `os.Exit` inside RunE (`riff`, `operator` on `*riff.ExitCodeError`) call `sink.JSONError` explicitly before exiting, since `execute()` never resumes after an exit.
**Why**: one failure writer for the whole CLI (spec § Envelope: verbs never hand-format it); the success encoder is the only per-verb edit.
**Rejected**: a per-verb `jsonRunE` RunE wrapper — it duplicated the central writer once both existed, and the write tracker would have made it a silent no-op.
*Introduced by*: 260911-fr5t-cli-spawn-and-steer-receipts

### `tab_web` follows the `board` action-enum shape
**Decision**: `tab_web` is one row on path `tab web` with `action` as positional 1, `--show`/`--json` persistent on the parent, a `Format`-rendered composite positional for `@N/web/<n>`, and per-action requirements enforced by the verb.
**Why**: `board` already established the shape; a variant model would be a second mechanism for the same thing.
**Rejected**: `Row.Actions`/`ActionVariant` (duplication); four tools (spec Principle 3 forbids).
*Introduced by*: 260911-fr5t-cli-spawn-and-steer-receipts

### `riff` gains `-L`/`--session`/`--repo`
**Decision**: three optional CLI flags onto the engine's existing `Server`/`Session`/`RepoRoot` seams; the MCP row requires `server` and `repo`.
**Why**: the MCP executor strips `$TMUX` and runs from the ssh landing directory, so the spec's `riff` tool is unsatisfiable without explicit targeting (D8).
**Rejected**: deferring `riff` (leaves the Spawn intent's flagship tool unshipped); tool-side `$TMUX`/cwd injection (a bypass, spec Principle 1).
*Introduced by*: 260911-fr5t-cli-spawn-and-steer-receipts
