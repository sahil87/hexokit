package main

import (
	"regexp"
	"slices"
	"sort"
	"strings"
	"testing"
	"time"

	"rk/internal/operator"

	"github.com/spf13/cobra"
)

const briefShapeServer = "loom"

var briefShapePattern = regexp.MustCompile("rk ((?:mux|operator|tab|riff)(?: [a-z|]+)*) -L " + briefShapeServer)

// expandVerbAlternatives expands `a b|c` into ["a b", "a c"].
func expandVerbAlternatives(path string) []string {
	paths := []string{""}
	for _, word := range strings.Fields(path) {
		var next []string
		for _, prefix := range paths {
			for _, alt := range strings.Split(word, "|") {
				next = append(next, strings.TrimSpace(prefix+" "+alt))
			}
		}
		paths = next
	}
	return paths
}

func renderedBriefShapes(t *testing.T) []string {
	t.Helper()
	brief := operator.RenderBrief(operator.BriefInput{Server: briefShapeServer, Now: time.Now()})
	seen := map[string]bool{}
	for _, m := range briefShapePattern.FindAllStringSubmatch(brief, -1) {
		for _, p := range expandVerbAlternatives(m[1]) {
			seen[p] = true
		}
	}
	shapes := make([]string, 0, len(seen))
	for p := range seen {
		shapes = append(shapes, p)
	}
	sort.Strings(shapes)
	return shapes
}

func parseShapeFlags(t *testing.T, shape string) *cobra.Command {
	t.Helper()
	argv := append(strings.Fields(shape), "-L", briefShapeServer)
	cmd, rest, err := rootCmd.Find(argv)
	if err != nil {
		t.Fatalf("%q: %v", shape, err)
	}
	if got := strings.TrimPrefix(cmd.CommandPath(), rootCmd.Name()+" "); got != shape {
		t.Fatalf("%q resolved to %q", shape, got)
	}
	if cmd.DisableFlagParsing {
		err = cmd.Flags().Parse(rest)
	} else {
		err = cmd.ParseFlags(rest)
	}
	if err != nil {
		t.Fatalf("%q: parsing -L: %v", shape, err)
	}
	return cmd
}

// TestRenderedBriefCommandShapesAcceptServerFlag: every command shape the
// brief renders with `-L <server>` parses it in the rendered position.
func TestRenderedBriefCommandShapesAcceptServerFlag(t *testing.T) {
	shapes := renderedBriefShapes(t)
	for _, want := range []string{
		"mux capture", "mux send", "mux inventory",
		"operator track add", "operator track update", "operator track rm", "operator track list",
		"operator track note", "operator track pause", "operator track observe",
		"operator brief", "tab new", "riff",
	} {
		if !slices.Contains(shapes, want) {
			t.Errorf("the rendered brief carries no %q command with -L", want)
		}
	}
	for _, shape := range shapes {
		t.Run(shape, func(t *testing.T) {
			cmd := parseShapeFlags(t, shape)
			flag := cmd.Flags().Lookup("server")
			if flag == nil {
				t.Fatalf("%q has no server flag", shape)
			}
			if got := flag.Value.String(); got != briefShapeServer {
				t.Errorf("server = %q, want %q", got, briefShapeServer)
			}
			_ = flag.Value.Set(flag.DefValue)
			flag.Changed = false
		})
	}
}
