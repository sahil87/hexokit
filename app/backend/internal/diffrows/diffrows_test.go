package diffrows

import (
	"strings"
	"testing"
)

func TestParsePatchAnchorsDeletions(t *testing.T) {
	patch := strings.Join([]string{
		"@@ -10,4 +10,5 @@ func Example() {",
		" ctxA",
		"-gone",
		"+first",
		"+second",
		" ctxB",
		`\ No newline at end of file`,
	}, "\n")

	rows := ParsePatch(patch)
	if len(rows) != 6 {
		t.Fatalf("rows = %d, want 6 (header + 5 body rows)", len(rows))
	}
	if rows[0].Kind != RowHunk || rows[0].Header != "@@ -10,4 +10,5 @@ func Example() {" {
		t.Errorf("row 0 = %+v, want the hunk header", rows[0])
	}
	if rows[1] != (PatchRow{Kind: RowCtx, Left: 10, Right: 10, At: 10, Text: "ctxA"}) {
		t.Errorf("ctx row = %+v", rows[1])
	}
	// The deletion has no post-image line of its own; its anchor is the
	// post-image line it sat BEFORE.
	if rows[2].Kind != RowDel || rows[2].Left != 11 || rows[2].Right != 0 || rows[2].At != 11 {
		t.Errorf("del row = %+v, want left 11 / right 0 / at 11", rows[2])
	}
	if rows[3].Kind != RowAdd || rows[3].Right != 11 || rows[3].Left != 0 {
		t.Errorf("first add row = %+v", rows[3])
	}
	if rows[4].Kind != RowAdd || rows[4].Right != 12 {
		t.Errorf("second add row = %+v", rows[4])
	}
	if rows[5].Kind != RowCtx || rows[5].Left != 12 || rows[5].Right != 13 {
		t.Errorf("trailing ctx row = %+v", rows[5])
	}
}

func TestParsePatchDegradesOnMalformedInput(t *testing.T) {
	if rows := ParsePatch(""); rows != nil {
		t.Errorf("empty patch = %+v, want nil", rows)
	}
	// Body lines before any header are dropped rather than mis-numbered.
	if rows := ParsePatch("+orphan\n-orphan"); rows != nil {
		t.Errorf("headerless patch = %+v, want nil", rows)
	}
	rows := ParsePatch("@@ garbage @@\n+x")
	if len(rows) != 2 || rows[1].Right != 1 {
		t.Errorf("unparseable header: rows = %+v, want the hunk to start at line 1", rows)
	}
}

func TestCollectRunsGroupsBySideAndContiguity(t *testing.T) {
	rows := ParsePatch(strings.Join([]string{
		"@@ -1,3 +1,3 @@",
		" a",
		"-b",
		"+B",
		" c",
	}, "\n"))
	runs := CollectRuns(rows)
	if len(runs) != 3 {
		t.Fatalf("runs = %d (%+v), want 3", len(runs), runs)
	}
	if runs[0].Side != SideRight || runs[0].Start != 1 || runs[0].Count != 1 {
		t.Errorf("run 0 = %+v", runs[0])
	}
	// The deletion lexes against the PRE-image, so it cannot join the
	// post-image run around it.
	if runs[1].Side != SideLeft || runs[1].Start != 2 || runs[1].Count != 1 {
		t.Errorf("run 1 = %+v", runs[1])
	}
	if runs[2].Side != SideRight || runs[2].Start != 2 || runs[2].Count != 2 {
		t.Errorf("run 2 = %+v", runs[2])
	}
}

func TestTokenClassUsesChromaShortNames(t *testing.T) {
	lexer := LexerFor("main.go")
	if lexer == nil {
		t.Fatal("LexerFor(main.go) = nil, want the Go lexer")
	}
	spans := LexLines(lexer, []string{"package main", "", "func f() int { return 1 }"})
	if len(spans) != 3 {
		t.Fatalf("spans = %d lines, want 3", len(spans))
	}
	classes := map[string]bool{}
	for _, line := range spans {
		for _, span := range line {
			classes[span.Class] = true
		}
	}
	// Chroma's table maps the most specific type it knows (mi = integer
	// literal), which is why the stylesheet colours the sub-classes too.
	for _, want := range []string{"kn", "nf", "mi"} {
		if !classes[want] {
			t.Errorf("class %q absent; got %v", want, classes)
		}
	}
	// Reassembling the spans must reproduce the source line byte for byte —
	// the renderer concatenates them straight into the row.
	var rebuilt strings.Builder
	for _, span := range spans[2] {
		rebuilt.WriteString(span.Text)
	}
	if rebuilt.String() != "func f() int { return 1 }" {
		t.Errorf("rebuilt line = %q", rebuilt.String())
	}
}

func TestLexerForUnknownExtensionIsNil(t *testing.T) {
	if lexer := LexerFor("notes.unknown-extension"); lexer != nil {
		t.Errorf("LexerFor(unknown) = %v, want nil (plain rows)", lexer.Config().Name)
	}
}

func TestLexWindowPadsAndReportsRefine(t *testing.T) {
	lines := make([]string, 400)
	for i := range lines {
		lines[i] = "x := 1"
	}
	lexer := LexerFor("a.go")

	// A window anchored at line 1 needs no leading pad, so it cannot have
	// guessed.
	spans, refine, coloured := LexWindow(lexer, lines, 1, 10)
	if len(spans) != 10 {
		t.Fatalf("spans = %d, want 10", len(spans))
	}
	if refine {
		t.Error("refine = true for a window at line 1, want false")
	}
	if !coloured {
		t.Error("coloured = false with a real lexer, want true")
	}

	// A window in the middle entered with a guessed state.
	spans, refine, _ = LexWindow(lexer, lines, 200, 10)
	if len(spans) != 10 || !refine {
		t.Errorf("mid-blob window: spans = %d, refine = %v; want 10, true", len(spans), refine)
	}

	// Past the end is an empty answer, not a panic.
	if spans, refine, _ := LexWindow(lexer, lines, 5000, 10); spans != nil || refine {
		t.Errorf("out-of-range window = %v, %v", spans, refine)
	}

	// No matching lexer: plain rows, and `coloured` says so — the wire's
	// `highlighted` flag is derived from it.
	if _, _, coloured := LexWindow(nil, lines, 1, 10); coloured {
		t.Error("coloured = true with a nil lexer, want false")
	}
}

func TestLexWindowByteCapDropsContextThenColour(t *testing.T) {
	// One line just over the byte cap: even with the pads dropped the window
	// cannot be lexed, so the rows serve plain.
	huge := []string{strings.Repeat("a", WindowByteCap+1)}
	spans, refine, coloured := LexWindow(LexerFor("a.go"), huge, 1, 1)
	if refine {
		t.Error("refine = true over the byte cap, want false (nothing will improve it)")
	}
	if coloured {
		t.Error("coloured = true over the byte cap, want false (the rows serve plain)")
	}
	if len(spans) != 1 || len(spans[0]) != 1 || spans[0][0].Class != "" {
		t.Errorf("over-cap spans = %+v, want one classless span", spans)
	}

	// Lines that fit only once the pads are dropped still get colour.
	padHeavy := make([]string, 400)
	for i := range padHeavy {
		padHeavy[i] = strings.Repeat("b", 4096)
	}
	padHeavy[200] = "package main"
	spans, _, _ = LexWindow(LexerFor("a.go"), padHeavy, 201, 1)
	if len(spans) != 1 {
		t.Fatalf("pad-dropped spans = %+v", spans)
	}
	if len(spans[0]) == 0 || spans[0][0].Class == "" {
		t.Errorf("pad-dropped window lost its colour: %+v", spans[0])
	}
}
