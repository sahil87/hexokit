package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"time"

	"rk/internal/inject"
	"rk/internal/promptscan"
	"rk/internal/tmux"

	"github.com/spf13/cobra"
)

// rk mux send <target> — deliver a message into an agent's tmux pane, gated on
// the pane's @rk_agent_state, with novelty-probed delivery (the agent-send
// injection engine in internal/inject — named-buffer bracketed paste, novelty
// echo probe, probe-gated Enter, post-Enter observation, bounded
// recovery — never fab pane send's blind send-keys + trailing Enter). No daemon
// dependency: tmux is addressed directly from the caller's context.
//
// The gate matrix (fab-kit's idleGate verbatim) reads the reconciled
// @rk_agent_state:
//
//	state    | plain        | --answer
//	---------+--------------+--------------------------------
//	unknown  | warn + send  | warn + send
//	idle     | send         | send
//	waiting  | refuse       | send (this send IS the answer)
//	active   | refuse       | refuse (never interrupt a working agent)
//
// The unknown row's warning names the pane's foreground command when it is not
// a plain shell (a hook-less agent may be running uninstrumented). Every
// delivery path — engine paste and --key sends alike — first clears an active
// pane mode via tmux.ClearPaneModeCtx (a copy-mode pane eats keys); a guard
// failure aborts pre-delivery with exit 1.
//
// --force skips the gate (target existence is still validated); --answer and
// --force are mutually exclusive. Refusals name the state, print to stderr,
// exit 1. stdout carries exactly ONE report line: `delivered %N` (no
// non-submission detected), `unverified %N` (Enter sent, pane unchanged), `staged %N`
// (--no-enter), `sent %N` (--key sends), or the await report word when --await
// is used. Exit codes follow the toolkit
// convention: 0 success, 1 operational failure, 2 usage.

// muxCmdTimeout caps each tmux subprocess the verbs spawn (Constitution §I:
// 5-10s for short-lived tmux helpers). The injection engine's probe sleeps
// additionally run under the caller's context.
const muxCmdTimeout = 5 * time.Second

var (
	muxSendKeysFlag    []string
	muxSendAnswerFlag  bool
	muxSendForceFlag   bool
	muxSendNoEnterFlag bool
	muxSendAwaitFlag   string
	muxSendTimeoutFlag int
	muxSendJSONFlag    bool
)

// sendFlagAuto is the NoOptDefVal sentinel for --await (the present.go
// pattern): a bare --await parses to this sentinel (use the default state set)
// while --await=idle,waiting carries the set.
const sendFlagAuto = "\x00auto"

// Envelope reason tokens and hints for the send/await failure classes. The
// reason tokens reuse the /send route's 409 codes verbatim (docs/specs/mcp.md
// § Receipts: one engine, one evidence vocabulary); the hints are the
// machine-neutral next steps.
const (
	sendReasonProbeFailure     = "probe_failure"
	sendReasonStagedSend       = "staged_send_failure"
	sendReasonSubmitUnverified = "submit_unverified"

	sendHintProbeFailure     = "check the pane before resending; a resend would duplicate the staged text"
	sendHintStagedSend       = "press Enter in the pane to submit"
	sendHintSubmitUnverified = "capture the pane before resending"
	sendHintSelectMenu       = "a select menu takes keys: --key Enter picks the highlighted option, --key Down/--key Up move first"
	// muxSendMenuLines is how much of the screen the select-menu check reads:
	// the classifier's window plus room for the harness's status lines.
	muxSendMenuLines       = promptscan.SelectMenuWindow + 8
	sendHintWaitingRefusal = "use --answer if this send is the reply the agent waits for"
	sendHintAwaitGone      = "the message was delivered before the pane died"
	sendHintAwaitNoStart   = "delivered; the wait could not start"
)

// sendReceipt is the `mux send --json` success document (docs/specs/mcp.md
// § Receipts): the frozen report word, the resolved pane, the resolved server,
// and whether Enter rode the delivery (delivered only — a --key send is not
// the engine's probe-gated Enter, even when the key is Enter). Await is
// present only under --await and nests the await phase's receipt.
type sendReceipt struct {
	Report string        `json:"report"`
	Target string        `json:"target"`
	Server string        `json:"server"`
	Enter  bool          `json:"enter"`
	Await  *awaitReceipt `json:"await,omitempty"`
}

var muxSendCmd = &cobra.Command{
	Use:   "send <target> [<message> | -] [--key <key>]... [--answer | --force] [--no-enter] [--await[=<states>]] [--timeout <secs>]",
	Short: "Deliver a message into an agent's pane, gated on its agent state",
	Long: "Deliver a message into an agent's tmux pane with non-submission detection " +
		"(bracketed paste + echo probe + probe-gated Enter + post-Enter frame observation), gated on the pane's " +
		tmux.AgentStateOption + ": idle sends; waiting refuses unless --answer (this send IS " +
		"the answer it waits for); active always refuses; unknown warns and sends, naming " +
		"the foreground process when it is not a plain shell. --force skips the gate. " +
		"Every delivery — text and --key alike — first clears an active pane mode " +
		"(a scrolled pane's copy-mode would otherwise eat the keys); a guard failure " +
		"aborts before anything is delivered.\n\n" +
		"Payload (exactly one): a positional message, `-` to read it from stdin, or " +
		"one or more --key <name> flags sending raw tmux key names (Enter, Up, C-c) " +
		"post-gate with no paste or probe. --no-enter stages the text without " +
		"submitting. --await[=<states>] (default idle,waiting) then blocks until the " +
		"peer reaches one of those states, printing the await report word; " +
		"--timeout bounds that wait (observer only).\n\n" +
		"Reports: delivered means no non-submission was detected; unverified means " +
		"Enter was sent but the pane stayed unchanged; staged is --no-enter; sent " +
		"is --key. An unverified send exits 1 and must be inspected before resending.\n\n" +
		"--json emits exactly one JSON document on stdout: on success the delivery " +
		"receipt {\"report\",\"target\",\"server\",\"enter\",\"await\"?} (the report word " +
		"inside result; the human report line and the unverified line are suppressed); " +
		"on failure {\"ok\":false,\"error\":{\"code\",\"message\",\"hint\"?,\"reason\"?}} " +
		"with the injection outcome as reason (probe_failure, staged_send_failure, " +
		"submit_unverified). Exit codes are unchanged.\n\n" +
		"Targets: %N (pane), @N (window — resolves to its agent pane), " +
		"=session:window (exact). Bare session:window names are rejected.",
	Example: "  rk mux send %5 \"keep going\"\n" +
		"  rk mux send @3 - < prompt.txt\n" +
		"  rk mux send =work:agent --key Enter",
	Args: usageArgs(cobra.RangeArgs(1, 2)),
	RunE: func(cmd *cobra.Command, args []string) error {
		return runMuxSend(cmd, args)
	},
}

func init() {
	muxSendCmd.Flags().StringArrayVar(&muxSendKeysFlag, "key", nil,
		"Send a tmux key name instead of text (repeatable; e.g. --key Enter, --key C-c)")
	muxSendCmd.Flags().BoolVar(&muxSendAnswerFlag, "answer", false,
		"This send answers the target's pending question (a waiting pane accepts it)")
	muxSendCmd.Flags().BoolVar(&muxSendForceFlag, "force", false,
		"Skip the agent-state gate (the target must still exist)")
	muxSendCmd.Flags().BoolVar(&muxSendNoEnterFlag, "no-enter", false,
		"Stage the text in the input box without submitting (no Enter)")
	muxSendCmd.Flags().StringVar(&muxSendAwaitFlag, "await", "",
		"After submitting, block until the peer reaches one of these states (optional set; default idle,waiting)")
	muxSendCmd.Flags().Lookup("await").NoOptDefVal = sendFlagAuto
	muxSendCmd.Flags().IntVar(&muxSendTimeoutFlag, "timeout", awaitDefaultTimeoutSec,
		"Seconds the --await phase may run before reporting `running` (0 = indefinite)")
	muxSendCmd.Flags().BoolVar(&muxSendJSONFlag, "json", false,
		"Emit exactly one JSON document on stdout (the delivery receipt; the human report line is suppressed)")
	muxSendCmd.MarkFlagsMutuallyExclusive("answer", "force")
}

// muxSend*Fn are package-level seams so runMuxSend can be tested without a
// live tmux server (the present.go/role.go pattern); the defaults delegate to
// internal/tmux / internal/inject / the rk notify send path.
var (
	muxSendEngineSendFn = func(ctx context.Context, engine *inject.Engine, t inject.Tmux, server, paneID, text string, submit bool) error {
		return engine.Send(ctx, t, server, paneID, text, submit)
	}
	muxSendKeysFn = func(ctx context.Context, paneID, server string, keys ...string) error {
		return tmux.SendKeysToPane(ctx, paneID, server, keys...)
	}
	muxSendClearModeFn = func(ctx context.Context, paneID, server string) error {
		return tmux.ClearPaneModeCtx(ctx, paneID, server)
	}
	muxSendFactsFn = func(ctx context.Context, paneID, server string) (tmux.PaneFacts, error) {
		return tmux.PaneFactsCtx(ctx, paneID, server)
	}
	muxSendPaneExistsFn = func(ctx context.Context, paneID, server string) (bool, error) {
		return tmux.PaneExists(ctx, paneID, server)
	}
	muxSendResolveWindowFn = func(ctx context.Context, windowTarget, server string) (string, error) {
		return tmux.ResolveAgentPane(ctx, windowTarget, server)
	}
	muxAwaitObserveFn = func(ctx context.Context, deps awaitDeps, panes []string, p awaitParams) (string, string, error) {
		return awaitObserve(ctx, deps, panes, p)
	}
	// muxStdinFn supplies the stdin reader for the `-` payload form (a var so
	// tests can feed a buffer).
	muxStdinFn = func() io.Reader { return os.Stdin }
	// muxBufferNameFn derives the CLI's per-invocation buffer name (never the
	// daemon's rk-agent-send — a CLI send can never clobber a concurrent daemon
	// send's buffer). A var so tests get a stable name.
	muxBufferNameFn = func() string { return fmt.Sprintf("rk-send-%d", os.Getpid()) }
)

// cliInjectTmux is the CLI's inject.Tmux substrate: name-parameterized buffer
// primitives straight from internal/tmux (the daemon's adapter ignores the
// name because its buffer is fixed; the CLI's per-invocation name rides it).
type cliInjectTmux struct {
	recoveryAttempted *bool
}

func (cliInjectTmux) ClearPaneMode(ctx context.Context, paneID, server string) error {
	return tmux.ClearPaneModeCtx(ctx, paneID, server)
}
func (cliInjectTmux) CapturePane(ctx context.Context, paneID string, lines int, server string) (string, error) {
	return tmux.CapturePaneCtx(ctx, paneID, lines, server)
}
func (cliInjectTmux) SetBuffer(ctx context.Context, name, text, server string) error {
	return tmux.SetBufferCtx(ctx, name, text, server)
}
func (cliInjectTmux) PasteBuffer(ctx context.Context, name, paneID, server string) error {
	return tmux.PasteBufferCtx(ctx, name, paneID, server)
}
func (cliInjectTmux) PasteBufferRaw(ctx context.Context, name, paneID, server string) error {
	return tmux.PasteBufferRawCtx(ctx, name, paneID, server)
}
func (cliInjectTmux) SendEnter(ctx context.Context, paneID, server string) error {
	return tmux.SendEnterToPaneCtx(ctx, paneID, server)
}
func (cliInjectTmux) PaneSize(ctx context.Context, paneID, server string) (int, int, error) {
	return tmux.PaneSizeCtx(ctx, paneID, server)
}
func (a cliInjectTmux) SendKeys(ctx context.Context, paneID, server string, keys ...string) error {
	// The shared engine uses this primitive only for recovery clears. Recording
	// the attempt lets the CLI surface that the successful path included a retry.
	if a.recoveryAttempted != nil {
		*a.recoveryAttempted = true
	}
	return tmux.SendKeysToPane(ctx, paneID, server, keys...)
}

// resolvePaneTarget resolves a parsed mux target to its pane ID: pane IDs pass
// through; window forms route to the window's agent pane (the pane carrying a
// known @rk_agent_state, falling back to the active pane).
func resolvePaneTarget(ctx context.Context, pt tmux.PaneTarget, server string) (string, error) {
	if pt.PaneID != "" {
		return pt.PaneID, nil
	}
	paneID, err := muxSendResolveWindowFn(ctx, pt.WindowTarget, server)
	if err != nil {
		return "", fmt.Errorf("resolve window target %s: %w", pt.WindowTarget, err)
	}
	return paneID, nil
}

// sendEnvelopeError maps a runMuxSend failure onto its envelope document: the
// code from the exit class (the usageError wrap ⇒ usage, else operational) and
// the /send route's 409 tokens as reason for the three engine sentinels.
func sendEnvelopeError(err error) envelopeError {
	e := envelopeError{Code: envelopeCodeForErr(err), Message: err.Error()}
	var probeErr inject.ProbeFailure
	var stagedErr inject.StagedSendFailure
	var submitErr inject.SubmitUnverified
	switch {
	case errors.As(err, &probeErr):
		e.Reason, e.Hint = sendReasonProbeFailure, sendHintProbeFailure
	case errors.As(err, &stagedErr):
		e.Reason, e.Hint = sendReasonStagedSend, sendHintStagedSend
	case errors.As(err, &submitErr):
		e.Reason, e.Hint = sendReasonSubmitUnverified, sendHintSubmitUnverified
	}
	return e
}

// runMuxSend is the testable core: parse → payload XOR → resolve → gate →
// deliver → report → optionally await. Under --json every failure raised here
// first writes the ok:false envelope to stdout and still returns the error —
// the exit code and stderr are unchanged — and the success receipt replaces
// the human report line.
func runMuxSend(cmd *cobra.Command, args []string) error {
	sink := newSink(cmd)
	fail := func(err error) error {
		if muxSendJSONFlag {
			sink.JSONError(sendEnvelopeError(err))
		}
		return err
	}
	failHint := func(err error, hint string) error {
		if muxSendJSONFlag {
			e := sendEnvelopeError(err)
			e.Hint = hint
			sink.JSONError(e)
		}
		return err
	}

	pt, err := tmux.ParsePaneTarget(args[0])
	if err != nil {
		return fail(usageError(err))
	}

	// Payload XOR (R3): exactly one of positional message / `-` stdin / --key.
	// cobra's MarkFlagsMutuallyExclusive already rejects --answer + --force.
	var message string
	hasMessage := len(args) == 2
	hasKeys := len(muxSendKeysFlag) > 0
	if hasMessage == hasKeys {
		return fail(usageError(fmt.Errorf("exactly one payload is required: a positional message, `-` (stdin), or --key")))
	}
	if hasMessage {
		if args[1] == "-" {
			data, err := io.ReadAll(muxStdinFn())
			if err != nil {
				return fail(fmt.Errorf("read message from stdin: %w", err))
			}
			message = inject.Sanitize(string(data))
		} else {
			message = inject.Sanitize(args[1])
		}
		if strings.TrimSpace(message) == "" {
			return fail(usageError(fmt.Errorf("message text cannot be empty")))
		}
	}

	awaitRequested := cmd.Flags().Changed("await")
	if awaitRequested && muxSendNoEnterFlag {
		return fail(usageError(fmt.Errorf("--await requires a submitted message — it cannot combine with --no-enter")))
	}
	if muxSendTimeoutFlag < 0 {
		return fail(usageError(fmt.Errorf("--timeout must be >= 0 (0 = indefinite)")))
	}
	awaitStates := []string{tmux.AgentStateIdle, tmux.AgentStateWaiting}
	if awaitRequested && muxSendAwaitFlag != sendFlagAuto {
		if awaitStates, err = parseUntilStates(muxSendAwaitFlag); err != nil {
			return fail(usageError(err))
		}
	}

	parent := cmd.Context()
	if parent == nil {
		parent = context.Background()
	}
	// The bounded ctx covers only the one-shot delivery phase (resolve → gate →
	// inject — a handful of tmux subprocesses plus the probe's settle/retry
	// sleeps). The --await composition below rides the PARENT context: a wait
	// may run for the full --timeout (default 300s, 0 = indefinite), and only
	// its individual tmux reads carry timeouts (see prodAwaitDeps).
	ctx, cancel := context.WithTimeout(parent, muxCmdTimeout)
	defer cancel()

	server := muxServer()

	paneID, err := resolvePaneTarget(ctx, pt, server)
	if err != nil {
		return fail(err)
	}

	// The agent-state gate (R4). --force skips it but the target's existence is
	// still validated.
	if muxSendForceFlag {
		ok, err := muxSendPaneExistsFn(ctx, paneID, server)
		if err != nil {
			return fail(fmt.Errorf("check target pane: %w", err))
		}
		if !ok {
			return fail(fmt.Errorf("pane %s does not exist", paneID))
		}
	} else {
		facts, err := muxSendFactsFn(ctx, paneID, server)
		if err != nil {
			return fail(fmt.Errorf("read pane facts: %w", err))
		}
		switch facts.AgentState {
		case "":
			if facts.Command != "" && !tmux.IsShellCommand(facts.Command) {
				sink.Notef("warning: pane %s has no readable agent state — foreground process `%s` running; sending ungated\n", paneID, facts.Command)
			} else {
				sink.Notef("warning: pane %s has no readable agent state — sending ungated\n", paneID)
			}
		case tmux.AgentStateIdle:
		case tmux.AgentStateWaiting:
			if !muxSendAnswerFlag {
				return failHint(fmt.Errorf("refusing to send to pane %s: agent is waiting (use --answer if this send is the answer it waits for)", paneID), sendHintWaitingRefusal)
			}
		case tmux.AgentStateActive:
			return fail(fmt.Errorf("refusing to send to pane %s: agent is active (never interrupt a working agent)", paneID))
		}
		// A select menu (Claude Code's AskUserQuestion menus) reads ↑/↓ and
		// Enter only: pasted text is swallowed, the probe sees
		// no echo and withholds Enter, and the caller is left guessing. Refuse
		// typed text up front and name the keys. --force skips this with the
		// rest of the gate.
		if !hasKeys {
			if content, err := muxCapturePaneFn(ctx, paneID, muxSendMenuLines, server); err == nil {
				if r := promptscan.Scan(content); r.Indicator == promptscan.IndicatorSelectMenu {
					highlighted := "the highlighted option"
					if r.Highlighted > 0 {
						highlighted = fmt.Sprintf("option %d (highlighted)", r.Highlighted)
					}
					return failHint(fmt.Errorf("refusing to type into pane %s: it shows a select menu — typed text is not accepted there; send --key Enter to pick %s, or --key Down/--key Up to move first", paneID, highlighted), sendHintSelectMenu)
				}
			}
		}
	}

	// Delivery (R5).
	var report string
	switch {
	case hasKeys:
		// The same pane-mode guard the engine runs — a copy-mode pane would
		// bind the key names to copy-mode instead of the foreground process.
		if err := muxSendClearModeFn(ctx, paneID, server); err != nil {
			return fail(fmt.Errorf("clear pane mode: %w", err))
		}
		if err := muxSendKeysFn(ctx, paneID, server, muxSendKeysFlag...); err != nil {
			return fail(fmt.Errorf("send-keys: %w", err))
		}
		report = "sent"
	default:
		engine := inject.NewEngine(muxBufferNameFn())
		recoveryAttempted := false
		err := muxSendEngineSendFn(ctx, engine, cliInjectTmux{recoveryAttempted: &recoveryAttempted}, server, paneID, message, !muxSendNoEnterFlag)
		if err != nil {
			var probeErr inject.ProbeFailure
			if errors.As(err, &probeErr) {
				// The 409's CLI analog: text stays staged in the composer, no
				// blind Enter, and the failure is visible to scripts (exit 1).
				return fail(probeErr)
			}
			var submitErr inject.SubmitUnverified
			if errors.As(err, &submitErr) {
				// Under --json the fact travels as reason submit_unverified; a
				// second stdout line would break the one-document contract.
				if !muxSendJSONFlag {
					sink.Dataf("unverified %s\n", paneID)
				}
				return fail(submitErr)
			}
			return fail(err)
		}
		if recoveryAttempted {
			sink.Notef("delivery retried after a baseline-matched composer clear\n")
		}
		report = "delivered"
		if muxSendNoEnterFlag {
			report = "staged"
		}
	}

	// Composed ask-and-wait (R6): the await report word replaces the delivery
	// report as stdout's single line. A report is printed even when the await
	// ends in an error (the `gone` contract: report on stdout, exit 1); when the
	// await fails WITHOUT a report (e.g. the pane is uninstrumented), the
	// delivery report still prints — the delivery succeeded, the wait failed.
	if awaitRequested {
		delivery := deliveryReceipt(report, paneID, server)
		awaitReport, elapsed, err := muxSendAwaitPeer(parent, cmd, server, paneID, awaitStates)
		if muxSendJSONFlag {
			switch {
			case err != nil && awaitReport == "gone":
				sink.JSONError(envelopeError{Code: envelopeCodeOperational, Message: err.Error(), Reason: awaitReasonGone, Hint: sendHintAwaitGone})
			case err != nil:
				sink.JSONError(envelopeError{Code: envelopeCodeOperational, Message: err.Error(), Hint: sendHintAwaitNoStart})
			default:
				delivery.Await = &awaitReceipt{Report: awaitReport, ElapsedMs: elapsed.Milliseconds()}
				if awaitReport == "running" {
					delivery.Await.Hint = awaitHintCallAgain
				} else {
					delivery.Await.Target = paneID
				}
				sink.JSONResult(delivery)
			}
			return err
		}
		deliveryReport := report
		report = awaitReport
		if report == "" && err != nil {
			report = deliveryReport
		}
		if report != "" {
			sink.Dataf("%s %s\n", report, paneID)
		}
		return err
	}

	if muxSendJSONFlag {
		sink.JSONResult(deliveryReceipt(report, paneID, server))
		return nil
	}
	sink.Dataf("%s %s\n", report, paneID)
	return nil
}

// deliveryReceipt builds the send receipt: enter is true only for delivered —
// staged (--no-enter) withheld it and a --key send is not the engine's
// probe-gated Enter, even when the key is Enter.
func deliveryReceipt(report, paneID, server string) sendReceipt {
	return sendReceipt{Report: report, Target: paneID, Server: server, Enter: report == "delivered"}
}

// sendAwaitActiveGrace bounds the post-submit watch for the peer's state to
// flip to `active` before the await proper begins. The flip watch closes the
// stale-state race — a bare await fired right after a send would otherwise
// return instantly on the peer's PRE-SEND idle — and its expiry falls through
// to the await rather than erroring (hooks may lag, or the peer may finish
// within the grace window). A package var SOLELY so tests can shrink it.
var sendAwaitActiveGrace = 10 * time.Second

// muxSendAwaitPeer runs the composed --await: first watch for the pane's state
// to flip to active under a bounded grace, then run the await observer with the
// requested state set. The grace watch is the observer itself with
// until={active} and the grace as its timeout. Two grace outcomes fall through
// to the await rather than ending the composition: "running" (grace expired —
// hooks may lag, or the peer finished within the grace window) and the
// uninstrumented verdict (the pane carries no @rk_agent_state — the delivery
// already happened, and the await phase re-applies the uninstrumented rule
// itself in case state appeared in the meantime). A "gone" verdict (or a read
// failure) propagates as the final report — the peer died. The returned
// duration measures the whole await phase (grace watch + observer) for the
// --json receipt's elapsed_ms.
func muxSendAwaitPeer(ctx context.Context, cmd *cobra.Command, server, paneID string, states []string) (string, time.Duration, error) {
	deps := muxAwaitDepsFn(server)
	start := deps.now()
	// --await stays single-target (non-goal): the fired-pane return is dropped,
	// and the report word printed by send stays the bare await report.
	graceReport, _, err := muxAwaitObserveFn(ctx, deps, []string{paneID}, awaitParams{
		until:   []string{tmux.AgentStateActive},
		timeout: sendAwaitActiveGrace,
	})
	if err != nil && !errors.Is(err, errUnobservable) {
		return graceReport, deps.now().Sub(start), err
	}
	// graceReport is "active" (flip observed) or "running" (grace expired) —
	// the race window is closed as well as it can be, either way.
	report, _, err := muxAwaitObserveFn(ctx, deps, []string{paneID}, awaitParams{
		until:   states,
		timeout: time.Duration(muxSendTimeoutFlag) * time.Second,
	})
	return report, deps.now().Sub(start), err
}
