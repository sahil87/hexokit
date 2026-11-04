package main

import (
	_ "embed"
	"fmt"
	"sort"
	"strings"

	"github.com/spf13/cobra"
)

//go:generate ../../../../scripts/sync-skill.sh

// skillBundle holds run-kit's canonical agent skill bundle, copied into this
// package dir from docs/site/skill.md by scripts/sync-skill.sh and embedded at
// build time. The Go module root is app/backend/ and docs/site/ sits above it,
// so //go:embed cannot reach the canonical file directly — the sync step copies
// it here first. The committed copy is what a clean `go build ./...` compiles;
// TestSkillEmbedMatchesCanonical keeps it byte-honest against docs/site/skill.md
// on every `go test`. This mirrors shll's `standards` embed mechanism, which the
// toolkit skill standard names as the one to reuse.
//
//go:embed skill/skill.md
var skillBundle []byte

// skillChangeTopic is the operator-led large-change workflow, versioned with
// the MCP tools and CLI it uses.
//
//go:embed skill/change.md
var skillChangeTopic []byte

// skillCronTopic holds the `cron` topic page, canonical at
// docs/site/skill/cron.md and synced into skill/cron.md alongside the core
// bundle. Same embed + drift-guard mechanism as the display topic, same
// static-only rules, independently bounded at ≤150 lines.
//
//go:embed skill/cron.md
var skillCronTopic []byte

// skillDisplayTopic holds the `display` topic page, canonical at
// docs/site/skill/display.md and synced into skill/display.md alongside the
// core bundle. Same embed + drift-guard mechanism (TestSkillDisplayEmbedMatchesCanonical),
// same static-only rules, independently bounded at ≤150 lines. Topic pages carry
// the depth (panes, iframes, the Visual Display Recipe) that would blow the core
// bundle's budget; the core carries only a topic-index line pointing here.
//
//go:embed skill/display.md
var skillDisplayTopic []byte

// skillCodeTopic holds the `code` topic page, canonical at
// docs/site/skill/code.md and synced into skill/code.md alongside the core
// bundle. Same embed + drift-guard mechanism as the display topic, same
// static-only rules, independently bounded at ≤150 lines.
//
//go:embed skill/code.md
var skillCodeTopic []byte

// skillGuiTopic holds the `gui` topic page, canonical at
// docs/site/skill/gui.md and synced into skill/gui.md alongside the core
// bundle. Same embed + drift-guard mechanism as the display topic, same
// static-only rules, independently bounded at ≤150 lines.
//
//go:embed skill/gui.md
var skillGuiTopic []byte

// skillMessagingTopic holds the `messaging` topic page, canonical at
// docs/site/skill/messaging.md and synced into skill/messaging.md alongside
// the core bundle. Same embed + drift-guard mechanism as the display topic,
// same static-only rules, independently bounded at ≤150 lines. It is the
// concept page for agent-to-agent messaging (the channel matrix and the
// readiness standard); the `mux` topic keeps the verb-reference depth.
//
//go:embed skill/messaging.md
var skillMessagingTopic []byte

// skillMuxTopic holds the `mux` topic page, canonical at
// docs/site/skill/mux.md and synced into skill/mux.md alongside the core
// bundle. Same embed + drift-guard mechanism as the display topic, same
// static-only rules, independently bounded at ≤150 lines.
//
//go:embed skill/mux.md
var skillMuxTopic []byte

// skillTutorialTopic holds the guided first-run tour, canonical at
// docs/site/skill/tutorial.md and synced beside the other topic pages.
//
//go:embed skill/tutorial.md
var skillTutorialTopic []byte

const tutorialTopicName = "tutorial"

// skillTopics maps a topic name to its embedded bundle. Bare `rk skill` prints
// the core bundle (skillBundle); `rk skill <topic>` prints the matching entry
// here; an unknown topic fails fast (usage error naming the valid topics). Add a
// row per topic page shipped.
var skillTopics = map[string][]byte{
	"change":          skillChangeTopic,
	"code":            skillCodeTopic,
	"cron":            skillCronTopic,
	"display":         skillDisplayTopic,
	"gui":             skillGuiTopic,
	"messaging":       skillMessagingTopic,
	"mux":             skillMuxTopic,
	tutorialTopicName: skillTutorialTopic,
}

// reservedTopicsName is the toolkit-standard reserved topic: `rk skill topics`
// enumerates the content-topic names machine-readably (one per line, stdout,
// exit 0). It is a machine affordance, not a topic page — it has no canonical
// docs/site file, must never become a skillTopics key, and stays out of the
// Topics: help line and the core bundle's topic index.
const reservedTopicsName = "topics"

// skillTopicNames returns the sorted list of valid topic names, for the
// unknown-topic error message, the Topics: help line, and the reserved
// `topics` enumeration (deterministic ordering).
func skillTopicNames() []string {
	names := make([]string, 0, len(skillTopics))
	for name := range skillTopics {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

// skillCmd implements the toolkit `<tool> skill` contract: bare `rk skill`
// prints the static core bundle — a usage briefing for an agent operating
// run-kit — as raw markdown to stdout, byte-identical to the canonical
// docs/site/skill.md, with empty stderr and exit 0. `rk skill <topic>` prints
// one topic page (docs/site/skill/<topic>.md) under the same contract. No
// rendering, no pager, no added framing (stdout is data). The bundles are
// static-only: they carry no session/pane/server-URL state — an agent derives
// its location directly (see the core bundle's "Where am I" block; the server
// URL comes from `rk url`), so the bytes never vary by where or when they run.
var skillCmd = &cobra.Command{
	Use:   "skill [topic]",
	Short: "Print run-kit's agent skill bundle (static usage briefing)",
	Long: "Print run-kit's agent skill bundle — a static, one-page usage briefing " +
		"for an agent operating run-kit (when to reach for it, its capabilities, how " +
		"it composes, and the gotchas). The bytes are identical on every invocation " +
		"and byte-identical to the repo's canonical docs/site/skill.md. Pass a topic " +
		"(e.g. `run-kit skill display`) to print that topic page instead, or `run-kit " +
		"skill topics` to list the topic names one per line. The bundle is static-only " +
		"— derive your location directly (get the server URL from `run-kit url`).\n\n" +
		"Topics: " + strings.Join(skillTopicNames(), ", "),
	Args:         cobra.MaximumNArgs(1),
	SilenceUsage: true,
	RunE: func(cmd *cobra.Command, args []string) error {
		bundle := skillBundle
		if len(args) == 1 {
			topic := args[0]
			if topic == reservedTopicsName {
				_, err := fmt.Fprint(cmd.OutOrStdout(),
					strings.Join(skillTopicNames(), "\n")+"\n")
				return err
			}
			b, ok := skillTopics[topic]
			if !ok {
				return usageError(fmt.Errorf("unknown topic %q (valid: %s)",
					topic, strings.Join(skillTopicNames(), ", ")))
			}
			bundle = b
		}
		_, err := fmt.Fprint(cmd.OutOrStdout(), string(bundle))
		return err
	},
}
