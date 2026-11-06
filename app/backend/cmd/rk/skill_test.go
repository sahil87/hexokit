package main

import (
	"bytes"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"rk/internal/layoutspec"
)

// skillLineBudget is the hard line-count ceiling for the skill bundle, per the
// shll `skill` standard (≤150 lines). Agents load this bundle every session and
// it will later be aggregated across every installed tool, so the budget is a
// contract, not a suggestion.
const skillLineBudget = 150

const tutorialPublicPath = "tutorial/"

// Core and topic invocations print their embedded content byte-for-byte.
func TestSkillTopicsPrintByteIdentical(t *testing.T) {
	cases := []struct {
		name  string
		topic string
		want  []byte
	}{
		{name: "core", want: skillBundle},
		{name: "change", topic: "change", want: skillChangeTopic},
		{name: "cron", topic: "cron", want: skillCronTopic},
		{name: "display", topic: "display", want: skillDisplayTopic},
		{name: "gui", topic: "gui", want: skillGuiTopic},
		{name: "code", topic: "code", want: skillCodeTopic},
		{name: "messaging", topic: "messaging", want: skillMessagingTopic},
		{name: "mux", topic: "mux", want: skillMuxTopic},
		{name: "restore", topic: "restore", want: skillRestoreTopic},
		{name: tutorialTopicName, topic: tutorialTopicName, want: skillTutorialTopic},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var stdout, stderr string
			var err error
			if tc.topic == "" {
				var outBuffer, errBuffer bytes.Buffer
				skillCmd.SetOut(&outBuffer)
				skillCmd.SetErr(&errBuffer)
				t.Cleanup(func() {
					skillCmd.SetOut(nil)
					skillCmd.SetErr(nil)
				})
				err = skillCmd.RunE(skillCmd, nil)
				stdout, stderr = outBuffer.String(), errBuffer.String()
			} else {
				stdout, stderr, err = runSkill(t, tc.topic)
			}
			if err != nil {
				t.Fatalf("skill %s RunE err = %v, want nil", tc.topic, err)
			}
			if !bytes.Equal([]byte(stdout), tc.want) {
				t.Errorf("stdout is not byte-identical (got %d bytes, want %d)", len(stdout), len(tc.want))
			}
			if stderr != "" {
				t.Errorf("skill %s wrote to stderr: %q", tc.topic, stderr)
			}
		})
	}
}

func TestSkillTopicsMatchCanonical(t *testing.T) {
	cases := []struct {
		name      string
		embedded  []byte
		canonical string
	}{
		{name: "core", embedded: skillBundle, canonical: filepath.Join("..", "..", "..", "..", "docs", "site", "skill.md")},
		{name: "change", embedded: skillChangeTopic, canonical: filepath.Join("..", "..", "..", "..", "docs", "site", "skill", "change.md")},
		{name: "cron", embedded: skillCronTopic, canonical: filepath.Join("..", "..", "..", "..", "docs", "site", "skill", "cron.md")},
		{name: "display", embedded: skillDisplayTopic, canonical: filepath.Join("..", "..", "..", "..", "docs", "site", "skill", "display.md")},
		{name: "gui", embedded: skillGuiTopic, canonical: filepath.Join("..", "..", "..", "..", "docs", "site", "skill", "gui.md")},
		{name: "code", embedded: skillCodeTopic, canonical: filepath.Join("..", "..", "..", "..", "docs", "site", "skill", "code.md")},
		{name: "messaging", embedded: skillMessagingTopic, canonical: filepath.Join("..", "..", "..", "..", "docs", "site", "skill", "messaging.md")},
		{name: "mux", embedded: skillMuxTopic, canonical: filepath.Join("..", "..", "..", "..", "docs", "site", "skill", "mux.md")},
		{name: "restore", embedded: skillRestoreTopic, canonical: filepath.Join("..", "..", "..", "..", "docs", "site", "skill", "restore.md")},
		{name: tutorialTopicName, embedded: skillTutorialTopic, canonical: filepath.Join("..", "..", "..", "..", "docs", "site", "skill", tutorialTopicName+".md")},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			canonical, err := os.ReadFile(tc.canonical)
			if err != nil {
				t.Fatalf("read canonical %s: %v", tc.canonical, err)
			}
			if !bytes.Equal(tc.embedded, canonical) {
				t.Errorf("embedded skill content has drifted from canonical %s", tc.canonical)
			}
		})
	}
}

// countLines applies the line-budget definition to content with or without a
// trailing newline.
func countLines(b []byte) int {
	lines := bytes.Count(b, []byte("\n"))
	if len(b) > 0 && !bytes.HasSuffix(b, []byte("\n")) {
		lines++
	}
	return lines
}

// Every embedded skill page has its own line budget.
func TestSkillTopicsWithinLineBudget(t *testing.T) {
	for _, tc := range []struct {
		name    string
		content []byte
	}{
		{name: "core", content: skillBundle},
		{name: "change", content: skillChangeTopic},
		{name: "cron", content: skillCronTopic},
		{name: "display", content: skillDisplayTopic},
		{name: "gui", content: skillGuiTopic},
		{name: "code", content: skillCodeTopic},
		{name: "messaging", content: skillMessagingTopic},
		{name: "mux", content: skillMuxTopic},
		{name: "restore", content: skillRestoreTopic},
		{name: tutorialTopicName, content: skillTutorialTopic},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if lines := countLines(tc.content); lines > skillLineBudget {
				t.Errorf("%s skill content is %d lines, over the %d-line budget", tc.name, lines, skillLineBudget)
			}
		})
	}
}

func TestTutorialPagesMatchTopic(t *testing.T) {
	canonicalPath := filepath.Join("..", "..", "..", "..", "docs", "site", "skill", tutorialTopicName+".md")
	canonical, err := os.ReadFile(canonicalPath)
	if err != nil {
		t.Fatalf("read canonical %s: %v", canonicalPath, err)
	}

	const tutorialPageName = "tutorial.html"
	for _, hash := range []string{"#ch1", "#ch2", "#ch3", "#ch4", "#ch5"} {
		ref := tutorialPublicPath + tutorialPageName + hash
		if !bytes.Contains(canonical, []byte(ref)) {
			t.Errorf("topic does not reference tutorial chapter %s", ref)
		}
	}

	refPattern := regexp.MustCompile(regexp.QuoteMeta(tutorialPublicPath) + `([A-Za-z0-9_.-]+\.html)`)
	for _, match := range refPattern.FindAllSubmatch(canonical, -1) {
		if name := string(match[1]); name != tutorialPageName {
			t.Errorf("topic references unexpected tutorial page %s", name)
		}
	}

	publicDir := filepath.Join("..", "..", "..", "..", "app", "frontend", "public", strings.TrimSuffix(tutorialPublicPath, "/"))
	entries, err := os.ReadDir(publicDir)
	if err != nil {
		t.Fatalf("read tutorial pages %s: %v", publicDir, err)
	}
	seen := false
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".html") {
			continue
		}
		if entry.Name() == tutorialPageName {
			seen = true
			continue
		}
		t.Errorf("tutorial page %s is not referenced by the topic", entry.Name())
	}
	if !seen {
		t.Errorf("tutorial page %s missing from %s", tutorialPageName, publicDir)
	}
}

func TestTutorialLayoutValuesParse(t *testing.T) {
	canonicalPath := filepath.Join("..", "..", "..", "..", "docs", "site", "skill", tutorialTopicName+".md")
	canonical, err := os.ReadFile(canonicalPath)
	if err != nil {
		t.Fatalf("read canonical %s: %v", canonicalPath, err)
	}

	layoutPattern := regexp.MustCompile(`rk tab layout '?([a-z(),:-]+)'?`)
	layouts := layoutPattern.FindAllSubmatch(canonical, -1)
	if len(layouts) == 0 {
		t.Fatal("tutorial contains no explicit layout values")
	}
	for _, match := range layouts {
		literal := string(match[1])
		if _, err := layoutspec.Parse(literal); err != nil {
			t.Errorf("layout literal %q does not parse: %v", literal, err)
		}
	}

	surfacePattern := regexp.MustCompile(`--(?:promote|add|rm) ([a-z]+)`)
	for _, match := range surfacePattern.FindAllSubmatch(canonical, -1) {
		literal := string(match[1])
		if !layoutspec.IsSurface(literal) {
			t.Errorf("surface literal %q is not registered", literal)
		}
	}
}

// runSkill drives `rk skill [args...]` through the real cobra Execute() seam —
// not skillCmd.RunE directly — so the MaximumNArgs(1)+usageArgs validator and
// cobra's stderr error path are exercised exactly as they are in production. It
// returns (stdout, stderr, err); err is the value Execute() returns, which
// execute() would classify via exitCode. Buffers are attached to the shared
// rootCmd (children inherit its out/err), and root flag/arg state is reset first
// so a prior test's Execute() cannot bleed into this one.
func runSkill(t *testing.T, args ...string) (string, string, error) {
	t.Helper()
	resetRootFlagState(t)
	var stdout, stderr bytes.Buffer
	rootCmd.SetOut(&stdout)
	rootCmd.SetErr(&stderr)
	rootCmd.SetArgs(append([]string{"skill"}, args...))
	t.Cleanup(func() {
		rootCmd.SetOut(nil)
		rootCmd.SetErr(nil)
		rootCmd.SetArgs(nil)
	})
	err := rootCmd.Execute()
	return stdout.String(), stderr.String(), err
}

// TestSkillBareStillPrintsCoreBundle asserts bare `rk skill` (no arg) still
// prints ONLY the core bundle, byte-identical — never a topic page inlined.
func TestSkillBareStillPrintsCoreBundle(t *testing.T) {
	stdout, stderr, err := runSkill(t)
	if err != nil {
		t.Fatalf("skill RunE err = %v, want nil (exit 0)", err)
	}
	if stdout != string(skillBundle) {
		t.Error("bare `skill` stdout is not the core bundle byte-identical")
	}
	if stderr != "" {
		t.Errorf("skill wrote to stderr: %q", stderr)
	}
}

// TestSkillUnknownTopicFailsFast asserts `rk skill bogus` fails fast: empty
// stdout, the diagnostic emitted on STDERR (cobra's `Error:` line, since the
// command runs through Execute()), a non-nil usage-class error (exit 2) whose
// message names the valid topics — never a silent empty stdout with exit 0.
func TestSkillUnknownTopicFailsFast(t *testing.T) {
	stdout, stderr, err := runSkill(t, "bogus")
	if err == nil {
		t.Fatal("skill bogus err = nil, want a usage error")
	}
	if stdout != "" {
		t.Errorf("skill bogus wrote to stdout: %q, want empty", stdout)
	}
	if exitCode(err) != exitUsage {
		t.Errorf("skill bogus exit code = %d, want %d (usage)", exitCode(err), exitUsage)
	}
	for _, want := range []string{"unknown topic", "change, code, cron, display, gui, messaging, mux, restore, " + tutorialTopicName} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("skill bogus error %q missing %q", err.Error(), want)
		}
		if !strings.Contains(stderr, want) {
			t.Errorf("skill bogus stderr %q missing %q", stderr, want)
		}
	}
}

// TestSkillReservedTopicsEnumerates pins the toolkit-standard reserved topic:
// `rk skill topics` prints the content-topic names one per line (sorted, a
// trailing newline, nothing else) to stdout with empty stderr and exit 0 — the
// scriptable enumeration the shll composer reaches as `shll skill rk topics`.
func TestSkillReservedTopicsEnumerates(t *testing.T) {
	stdout, stderr, err := runSkill(t, "topics")
	if err != nil {
		t.Fatalf("skill topics err = %v, want nil (exit 0)", err)
	}
	want := strings.Join(skillTopicNames(), "\n") + "\n"
	if stdout != want {
		t.Errorf("skill topics stdout = %q, want %q", stdout, want)
	}
	if stderr != "" {
		t.Errorf("skill topics wrote to stderr: %q", stderr)
	}
}

// TestSkillReservedTopicsNameStaysReserved guards the reserved-name rule:
// `topics` must never become a content topic (no skillTopics key, no canonical
// page) — a key would leak it into skillTopicNames(), the Topics: help line,
// and the unknown-topic error message.
func TestSkillReservedTopicsNameStaysReserved(t *testing.T) {
	if _, ok := skillTopics[reservedTopicsName]; ok {
		t.Fatalf("skillTopics contains reserved name %q — the standard reserves it in every tool's topic namespace", reservedTopicsName)
	}
}

// TestSkillHelpEnumeratesTopics pins the help-text mandate: the long help
// carries a Topics: line naming every shipped content topic, so a caller
// consulting --help before paying the core bundle's context cost can see what
// exists. The line enumerates content topics only — never the reserved name.
func TestSkillHelpEnumeratesTopics(t *testing.T) {
	var topicsLine string
	for _, line := range strings.Split(skillCmd.Long, "\n") {
		if strings.HasPrefix(line, "Topics: ") {
			topicsLine = line
			break
		}
	}
	if want := "Topics: " + strings.Join(skillTopicNames(), ", "); topicsLine != want {
		t.Errorf("skillCmd.Long Topics: line = %q, want exactly %q", topicsLine, want)
	}
	for _, name := range skillTopicNames() {
		if name == reservedTopicsName {
			t.Errorf("skillTopicNames() includes reserved name %q", reservedTopicsName)
		}
	}
}

// TestSkillTooManyArgsFailsFast pins the MaximumNArgs(1)+usageArgs contract: a
// second positional arg is a usage error (exit 2) with empty stdout and the
// diagnostic on stderr — the validator rejects it before RunE runs, so no bundle
// is ever printed.
func TestSkillTooManyArgsFailsFast(t *testing.T) {
	stdout, stderr, err := runSkill(t, "display", "extra")
	if err == nil {
		t.Fatal("skill display extra err = nil, want a usage error")
	}
	if stdout != "" {
		t.Errorf("skill display extra wrote to stdout: %q, want empty", stdout)
	}
	if exitCode(err) != exitUsage {
		t.Errorf("skill display extra exit code = %d, want %d (usage)", exitCode(err), exitUsage)
	}
	if stderr == "" {
		t.Error("skill display extra wrote nothing to stderr, want the arg-count diagnostic")
	}
}

// TestSkillCoreIndexesEveryTopic pins discoverability: the core bundle is what
// an agent loads every session (and what the MCP server serves as its
// instructions), so a topic page it never names is a page no agent finds. Every
// shipped content topic must appear in the core bundle as `rk skill <topic>`.
func TestSkillCoreIndexesEveryTopic(t *testing.T) {
	for _, name := range skillTopicNames() {
		ref := "`rk skill " + name + "`"
		if !bytes.Contains(skillBundle, []byte(ref)) {
			t.Errorf("core bundle never names topic %q (want %s in its Topics index)", name, ref)
		}
	}
}

// restoreTopicQuotedRe matches a quoted shell word. Quoted words are payloads
// (a message for `rk mux send`, a jq filter), never rk flags, so they are
// blanked before an invocation is parsed.
var restoreTopicQuotedRe = regexp.MustCompile(`"[^"]*"|'[^']*'`)

// restoreTopicCommandRe marks where an rk invocation starts in a fenced shell
// line: `rk ` at line start or after whitespace, `(` or `$`.
var restoreTopicCommandRe = regexp.MustCompile(`(?:^|[\s($])rk `)

// restoreTopicSeparators end an invocation: a comment, pipe, list operator,
// subshell close, or redirect.
var restoreTopicSeparators = []string{" #", " |", "&&", ";", ")", " >"}

// TestSkillRestoreTopicCommandsResolve is the restore page's drift guard: the
// page is a procedure an agent runs verbatim while sessions are down, so every
// rk command and flag it shows in a fenced block must exist in the live command
// tree. A renamed verb or dropped flag fails here instead of mid-recovery.
func TestSkillRestoreTopicCommandsResolve(t *testing.T) {
	inFence := false
	checked := 0
	for _, line := range strings.Split(string(skillRestoreTopic), "\n") {
		if strings.HasPrefix(strings.TrimSpace(line), "```") {
			inFence = !inFence
			continue
		}
		if !inFence {
			continue
		}
		line = restoreTopicQuotedRe.ReplaceAllString(line, "QUOTED")
		for _, loc := range restoreTopicCommandRe.FindAllStringIndex(line, -1) {
			invocation := line[loc[1]-len("rk "):]
			for _, sep := range restoreTopicSeparators {
				if i := strings.Index(invocation, sep); i >= 0 {
					invocation = invocation[:i]
				}
			}
			if assertRestoreTopicCommand(t, strings.TrimSpace(invocation)) {
				checked++
			}
		}
	}
	if checked == 0 {
		t.Fatal("restore topic shows no rk commands in fenced blocks")
	}
}

// assertRestoreTopicCommand resolves one rk invocation against rootCmd: the
// leading words must walk to a runnable command (a group command left with a
// non-flag word means a misspelt or removed subcommand), and every --long or
// -s flag token must be a local or inherited flag of that command. A bare
// `rk` with no command word (the `command -v rk` gate) is a mention, not an
// invocation: it reports false and checks nothing.
func assertRestoreTopicCommand(t *testing.T, invocation string) bool {
	t.Helper()
	fields := strings.Fields(invocation)[1:]
	var words []string
	for _, f := range fields {
		if strings.HasPrefix(f, "-") || strings.ContainsAny(f, "<>$%=@~/") || f == "QUOTED" {
			break
		}
		words = append(words, f)
	}
	if len(words) == 0 {
		return false
	}
	cmd, rest, err := rootCmd.Find(words)
	if err != nil || cmd == rootCmd {
		t.Errorf("%q: no rk command for %v (err %v)", invocation, words, err)
		return true
	}
	if cmd.HasSubCommands() && len(rest) > 0 {
		t.Errorf("%q: %q has no subcommand %q", invocation, cmd.CommandPath(), rest[0])
	}
	if !cmd.Runnable() {
		t.Errorf("%q: %q is not runnable", invocation, cmd.CommandPath())
	}
	for _, f := range fields {
		var flagFound bool
		switch {
		case strings.HasPrefix(f, "--"):
			name := strings.SplitN(strings.TrimPrefix(f, "--"), "=", 2)[0]
			flagFound = cmd.Flags().Lookup(name) != nil || cmd.InheritedFlags().Lookup(name) != nil
		case len(f) == 2 && f[0] == '-':
			short := f[1:]
			flagFound = cmd.Flags().ShorthandLookup(short) != nil || cmd.InheritedFlags().ShorthandLookup(short) != nil
		default:
			continue
		}
		if !flagFound {
			t.Errorf("%q: %q has no flag %s", invocation, cmd.CommandPath(), f)
		}
	}
	return true
}
