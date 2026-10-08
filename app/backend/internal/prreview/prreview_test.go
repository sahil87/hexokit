package prreview

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"rk/internal/diffrows"
)

func TestParsePRURL(t *testing.T) {
	cases := []struct {
		raw     string
		want    PRRef
		wantErr bool
	}{
		{raw: "https://github.com/sahil87/run-kit/pull/1024", want: PRRef{Host: "github.com", Owner: "sahil87", Repo: "run-kit", Number: 1024}},
		{raw: "https://ghe.corp.example/acme/tool/pull/7", want: PRRef{Host: "ghe.corp.example", Owner: "acme", Repo: "tool", Number: 7}},
		{raw: "https://github.com/sahil87/run-kit/pull/1024/files", wantErr: true},
		{raw: "https://github.com/sahil87/run-kit/issues/12", wantErr: true},
		{raw: "https://github.com/sahil87/run-kit/pull/zero", wantErr: true},
		{raw: "https://github.com/sahil87/run-kit/pull/0", wantErr: true},
		{raw: "not a url at all", wantErr: true},
		{raw: "", wantErr: true},
	}
	for _, tc := range cases {
		got, err := ParsePRURL(tc.raw)
		if tc.wantErr {
			if err == nil {
				t.Errorf("ParsePRURL(%q) = %+v, want error", tc.raw, got)
			}
			continue
		}
		if err != nil {
			t.Errorf("ParsePRURL(%q): %v", tc.raw, err)
			continue
		}
		if got != tc.want {
			t.Errorf("ParsePRURL(%q) = %+v, want %+v", tc.raw, got, tc.want)
		}
	}
}

func TestBlobCacheEvictsByBudgetAndScavengesOnceIdle(t *testing.T) {
	cache := newBlobCache(100)
	cache.put("sha1", "a.go", &blobEntry{lines: []string{"a"}, bytes: 60})
	cache.put("sha2", "b.go", &blobEntry{lines: []string{"b"}, bytes: 60})
	if cache.get("sha1", "a.go") != nil {
		t.Error("sha1 survived the budget; want evicted (LRU)")
	}
	if cache.get("sha2", "b.go") == nil {
		t.Error("sha2 evicted; want retained")
	}

	// An untouched cache scavenges exactly once per idle period.
	cache.lastUse = time.Now().Add(-2 * blobIdleWindow)
	cache.scavenge(time.Now())
	if len(cache.entries) != 0 {
		t.Errorf("entries after scavenge = %d, want 0", len(cache.entries))
	}
	cache.put("sha3", "c.go", &blobEntry{lines: []string{"c"}, bytes: 10})
	cache.scavenge(time.Now())
	if cache.get("sha3", "c.go") == nil {
		t.Error("a freshly-touched cache was scavenged; the latch must clear on touch")
	}
}

func TestSuggestionOnlyThreads(t *testing.T) {
	suggestion := "```suggestion\nreturn nil\n```"
	cases := []struct {
		name string
		body []string
		want bool
	}{
		{"single suggestion", []string{suggestion}, true},
		{"two suggestions", []string{suggestion, suggestion}, true},
		{"argument plus suggestion", []string{"this is wrong because…\n" + suggestion}, false},
		{"plain prose", []string{"please fix this"}, false},
		{"other fence", []string{"```go\nreturn nil\n```"}, false},
		{"unterminated fence", []string{"```suggestion\nreturn nil"}, false},
		{"no comments", nil, false},
	}
	for _, tc := range cases {
		thread := Thread{}
		for _, body := range tc.body {
			thread.Comments = append(thread.Comments, Comment{Body: body})
		}
		if got := thread.SuggestionOnly(); got != tc.want {
			t.Errorf("%s: SuggestionOnly() = %v, want %v", tc.name, got, tc.want)
		}
	}
}

// recordedCall is one gh invocation captured by the test seam.
type recordedCall struct {
	args  []string
	stdin string
}

func newRecordingFetcher(t *testing.T, responses map[string]string) (*Fetcher, *[]recordedCall) {
	t.Helper()
	calls := &[]recordedCall{}
	// The fetch pass runs its two reads concurrently, so the recorder is shared
	// across goroutines and must be guarded — otherwise -race fails here on a
	// harness bug that says nothing about the code under test.
	var mu sync.Mutex
	f := NewFetcher()
	f.available = func(context.Context) bool { return true }
	f.ghExec = func(_ context.Context, stdin []byte, args ...string) ([]byte, error) {
		mu.Lock()
		*calls = append(*calls, recordedCall{args: args, stdin: string(stdin)})
		mu.Unlock()
		joined := strings.Join(args, " ")
		for match, response := range responses {
			if strings.Contains(joined, match) {
				return []byte(response), nil
			}
		}
		return []byte("{}"), nil
	}
	return f, calls
}

// The whole point of --input -: a comment body is user-authored prose and must
// never appear in argv, where it is readable from the process table and one
// quoting mistake from a shell injection.
// GitHub's REST side/start_side and its GraphQL DiffSide enum take LEFT/RIGHT,
// never this package's one-letter wire form. Posting "R" fails the
// create-comment oneOf with `R is not a member of ["LEFT", "RIGHT"]`, and
// because the side is what breaks the match, the 422 names every OTHER
// subschema ("position wasn't supplied", "in_reply_to wasn't supplied",
// "subject_type wasn't supplied") and never the field at fault.
func TestWritePathsSpellSidesTheWayGitHubDoes(t *testing.T) {
	review := &Review{URL: "https://github.com/acme/tool/pull/7", HeadSha: "headsha"}

	for _, tc := range []struct {
		wire string
		want string
	}{
		{SideRight, "RIGHT"},
		{SideLeft, "LEFT"},
		{"", "RIGHT"}, // unset defaults to the post-image, as the composer does
	} {
		t.Run("single/"+tc.want, func(t *testing.T) {
			f, calls := newRecordingFetcher(t, nil)
			if err := f.AddComment(context.Background(), review, NewComment{
				Path: "a.go", Line: 12, StartLine: 9, Side: tc.wire, Body: "b", Mode: ModeSingle,
			}); err != nil {
				t.Fatalf("AddComment: %v", err)
			}
			var decoded map[string]any
			if err := json.Unmarshal([]byte((*calls)[0].stdin), &decoded); err != nil {
				t.Fatalf("stdin is not JSON: %v", err)
			}
			if decoded["side"] != tc.want {
				t.Errorf("side = %v, want %q", decoded["side"], tc.want)
			}
			// The multi-line anchor carries the same vocabulary.
			if decoded["start_side"] != tc.want {
				t.Errorf("start_side = %v, want %q", decoded["start_side"], tc.want)
			}
		})
	}

	// addPullRequestReviewThread's $side is DiffSide!, the same enum.
	t.Run("pending review thread", func(t *testing.T) {
		f, calls := newRecordingFetcher(t, map[string]string{
			"graphql": `{"data":{"repository":{"pullRequest":{"id":"PR_1","reviews":{"nodes":[{"id":"REV_1"}]}}}}}`,
		})
		if err := f.AddComment(context.Background(), review, NewComment{
			Path: "a.go", Line: 12, Side: SideLeft, Body: "b", Mode: ModeReview,
		}); err != nil {
			t.Fatalf("AddComment(review mode): %v", err)
		}
		if !strings.Contains((*calls)[1].stdin, `"LEFT"`) {
			t.Errorf("thread mutation variables = %s, want side LEFT", (*calls)[1].stdin)
		}
	})
}

func TestWritePathsSendBodiesOnStdinNeverArgv(t *testing.T) {
	body := "please fix `$(rm -rf /)`\nand also \"quote\" this"
	review := &Review{URL: "https://github.com/acme/tool/pull/7", HeadSha: "headsha"}

	t.Run("single comment", func(t *testing.T) {
		f, calls := newRecordingFetcher(t, nil)
		if err := f.AddComment(context.Background(), review, NewComment{
			Path: "a.go", Line: 12, Side: SideRight, Body: body, Mode: ModeSingle,
		}); err != nil {
			t.Fatalf("AddComment: %v", err)
		}
		if len(*calls) != 1 {
			t.Fatalf("calls = %d, want 1", len(*calls))
		}
		assertBodyOnStdin(t, (*calls)[0], body)
		var decoded map[string]any
		if err := json.Unmarshal([]byte((*calls)[0].stdin), &decoded); err != nil {
			t.Fatalf("stdin is not JSON: %v", err)
		}
		if decoded["commit_id"] != "headsha" || decoded["side"] != "RIGHT" || decoded["line"] != float64(12) {
			t.Errorf("stdin document = %v", decoded)
		}
	})

	t.Run("reply", func(t *testing.T) {
		f, calls := newRecordingFetcher(t, nil)
		if err := f.Reply(context.Background(), review, 4242, body); err != nil {
			t.Fatalf("Reply: %v", err)
		}
		assertBodyOnStdin(t, (*calls)[0], body)
		if !strings.Contains(strings.Join((*calls)[0].args, " "), "/comments/4242/replies") {
			t.Errorf("reply argv = %v", (*calls)[0].args)
		}
	})

	t.Run("pending review", func(t *testing.T) {
		f, calls := newRecordingFetcher(t, map[string]string{
			"graphql": `{"data":{"repository":{"pullRequest":{"id":"PR_1","reviews":{"nodes":[{"id":"REV_1"}]}}}}}`,
		})
		if err := f.AddComment(context.Background(), review, NewComment{
			Path: "a.go", Line: 12, Side: SideRight, Body: body, Mode: ModeReview,
		}); err != nil {
			t.Fatalf("AddComment(review mode): %v", err)
		}
		if len(*calls) != 2 {
			t.Fatalf("calls = %d, want 2 (find pending review, then add thread)", len(*calls))
		}
		// Even the GraphQL variables ride stdin, so the body never lands on argv.
		assertBodyOnStdin(t, (*calls)[1], body)
	})

	t.Run("resolve and react", func(t *testing.T) {
		f, calls := newRecordingFetcher(t, nil)
		if err := f.SetThreadResolved(context.Background(), review, "THREAD_1", true); err != nil {
			t.Fatalf("SetThreadResolved: %v", err)
		}
		if !strings.Contains((*calls)[0].stdin, "resolveReviewThread") {
			t.Errorf("resolve stdin = %q", (*calls)[0].stdin)
		}
		if err := f.MarkEyes(context.Background(), review, 99); err != nil {
			t.Fatalf("MarkEyes: %v", err)
		}
		last := (*calls)[len(*calls)-1]
		if !strings.Contains(last.stdin, `"content":"eyes"`) {
			t.Errorf("reaction stdin = %q", last.stdin)
		}
		if !strings.Contains(strings.Join(last.args, " "), "/pulls/comments/99/reactions") {
			t.Errorf("reaction argv = %v", last.args)
		}
	})
}

func assertBodyOnStdin(t *testing.T, call recordedCall, body string) {
	t.Helper()
	if !strings.Contains(call.stdin, "rm -rf") {
		t.Errorf("stdin does not carry the body: %q", call.stdin)
	}
	for _, arg := range call.args {
		if strings.Contains(arg, "rm -rf") || arg == body {
			t.Fatalf("body leaked into argv: %v", call.args)
		}
	}
	if !containsPair(call.args, "--input", "-") {
		t.Errorf("argv missing --input -: %v", call.args)
	}
}

func containsPair(args []string, first, second string) bool {
	for i := 0; i+1 < len(args); i++ {
		if args[i] == first && args[i+1] == second {
			return true
		}
	}
	return false
}

// Stale-while-revalidate: a gh blip on a PR that already has a cached document
// serves the cached one rather than blanking a mounted tile.
func TestGetKeepsLastGoodOnFetchError(t *testing.T) {
	f := NewFetcher()
	f.available = func(context.Context) bool { return true }
	cached := &Review{URL: "https://github.com/acme/tool/pull/7", FetchedAt: time.Now().Add(-time.Hour)}
	f.byURL[cached.URL] = cached
	f.ghExec = func(context.Context, []byte, ...string) ([]byte, error) {
		return nil, context.DeadlineExceeded
	}
	got, err := f.Get(context.Background(), cached.URL, true)
	if err != nil || got != cached {
		t.Errorf("Get on a gh error = %v, %v; want the cached document", got, err)
	}
}

func TestGetWithoutGhReportsUnavailable(t *testing.T) {
	f := NewFetcher()
	f.available = func(context.Context) bool { return false }
	if _, err := f.Get(context.Background(), "https://github.com/acme/tool/pull/7", false); err != ErrUnavailable {
		t.Errorf("Get with gh absent = %v, want ErrUnavailable", err)
	}
}

// The tier-2 background pass publishes its spans on its own goroutine while
// readers take them on request goroutines, so every touch of blobEntry.full
// goes through refineMu. This drives that seam concurrently — under
// `go test -race` it is what proves the guard, and without a test nothing ever
// STARTS the background goroutine, so removing the mutex would still pass.
func TestSpansForIsRaceFreeAcrossTheTier2Refine(t *testing.T) {
	// Long enough that a mid-blob window needs a leading pad (so refine fires
	// and queues the background pass), small enough to sit under
	// refinePassByteCap.
	lines := make([]string, 600)
	for i := range lines {
		lines[i] = "package main // line"
	}
	blob := strings.Join(lines, "\n")
	encoded, err := json.Marshal(ghContents{
		Content:  base64.StdEncoding.EncodeToString([]byte(blob)),
		Encoding: "base64",
		Type:     "file",
	})
	if err != nil {
		t.Fatal(err)
	}

	f := NewFetcher()
	f.available = func(context.Context) bool { return true }
	f.ghExec = func(context.Context, []byte, ...string) ([]byte, error) { return encoded, nil }
	ref := PRRef{Owner: "acme", Repo: "tool", Number: 7}

	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func(n int) {
			defer wg.Done()
			// Repeat so a reader is live both before and after the background
			// pass publishes.
			for r := 0; r < 20; r++ {
				start := 200 + n
				spans, _, coloured := f.spansFor(context.Background(), ref, "a.go", "headsha", start, 10)
				if len(spans) != 10 || !coloured {
					t.Errorf("spansFor(%d) = %d spans, coloured=%v; want 10, true", start, len(spans), coloured)
					return
				}
			}
		}(i)
	}
	wg.Wait()

	entry := f.blobs.get("headsha", "a.go")
	if entry == nil {
		t.Fatal("blob entry evicted; want cached")
	}
	// Wait for the background pass to publish before asserting on its effects.
	// Bounded so a broken tier 2 fails the test rather than hanging it.
	deadline := time.Now().Add(5 * time.Second)
	for {
		f.refineMu.Lock()
		published := entry.full != nil
		f.refineMu.Unlock()
		if published {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the tier-2 pass never published its spans")
		}
		time.Sleep(10 * time.Millisecond)
	}
	// Once published, a repeat read answers from the whole-blob result, so the
	// client is told there is nothing left to refine.
	if _, refine, _ := f.spansFor(context.Background(), ref, "a.go", "headsha", 200, 10); refine {
		t.Error("refine = true after the tier-2 pass published, want false")
	}
	// The pass credited its footprint to the ENTRY, not just the running total:
	// crediting only `used` would ratchet the budget upward on every refine and
	// evict live entries early, because evictLocked subtracts entry.bytes.
	if entry.bytes <= entryBytes(lines) {
		t.Errorf("entry.bytes = %d after the refine; want more than the %d the lines alone cost",
			entry.bytes, entryBytes(lines))
	}
}

// The budget must come back down when a refined entry is evicted. Before the
// fix, `note` credited only the running total, so `used` ratcheted up across
// refines until the list fully drained.
func TestBlobCacheRefineFootprintIsReclaimedOnEviction(t *testing.T) {
	cache := newBlobCache(500)
	cache.put("sha1", "a.go", &blobEntry{lines: []string{"a"}, bytes: 100})
	cache.note("sha1", "a.go", 100)
	if cache.used != 200 {
		t.Fatalf("used after note = %d, want 200", cache.used)
	}
	// Force the refined entry out: a second entry that fits only if sha1 goes.
	cache.put("sha2", "b.go", &blobEntry{lines: []string{"b"}, bytes: 400})
	if cache.get("sha1", "a.go") != nil {
		t.Fatal("sha1 survived the budget; want evicted (LRU)")
	}
	if cache.used != 400 {
		t.Errorf("used after evicting the refined entry = %d, want 400 (its spans returned too)", cache.used)
	}
	// A note for an entry that is already gone owes the budget nothing.
	cache.note("sha1", "a.go", 100)
	if cache.used != 400 {
		t.Errorf("used after noting an evicted entry = %d, want 400", cache.used)
	}
}

// Defense in depth behind the FindFile gates: pathEscape deliberately leaves
// `.` unescaped so a real filename survives the route segment intact, which
// means a `..` segment would otherwise be resolved by GitHub rather than by us.
func TestRepoRelativePathRefusesTraversalAndAbsolutePaths(t *testing.T) {
	for _, path := range []string{"app/main.go", "a.go", "dir/.env", "x..y/a.go"} {
		if !repoRelativePath(path) {
			t.Errorf("repoRelativePath(%q) = false, want true", path)
		}
	}
	for _, path := range []string{
		"",
		"/etc/passwd",
		"../../etc/passwd",
		"app/../../etc/passwd",
		"app/./main.go",
		"app//main.go",
		"app/main.go\nx",
		"app/ma\x00in.go",
	} {
		if repoRelativePath(path) {
			t.Errorf("repoRelativePath(%q) = true, want false", path)
		}
	}
}

// patchWithRows builds a patch whose parsed height is exactly want rows: one
// hunk header plus want-1 added lines.
func patchWithRows(want int) string {
	lines := []string{"@@ -1,0 +1," + strconv.Itoa(want-1) + " @@"}
	for i := 1; i < want; i++ {
		lines = append(lines, "+line")
	}
	return strings.Join(lines, "\n")
}

// The tile opens with its files already expanded, which is only affordable
// because structure is free (the patch is already cached) and because the two
// caps below keep any one PR from mounting everything at once — GitHub's
// Files-changed shape.
func TestEagerBudgetExpandsThePrefixAndCollapsesTheRest(t *testing.T) {
	t.Run("a file over the per-file cap collapses on its own account", func(t *testing.T) {
		files := []FileEntry{
			{Path: "small.go", HasPatch: true, Patch: patchWithRows(10)},
			{Path: "generated.lock", HasPatch: true, Patch: patchWithRows(maxEagerRowsPerFile + 1)},
			{Path: "after.go", HasPatch: true, Patch: patchWithRows(10)},
		}
		applyEagerBudget(files)

		if files[0].Collapsed != "" || len(files[0].Rows) != 10 {
			t.Errorf("small.go = %q with %d rows, want expanded", files[0].Collapsed, len(files[0].Rows))
		}
		if files[1].Collapsed != CollapsedLarge || files[1].Rows != nil {
			t.Errorf("generated.lock = %q with %d rows, want CollapsedLarge and no rows",
				files[1].Collapsed, len(files[1].Rows))
		}
		// The big file must not consume the shared budget — the reader still
		// gets everything after it.
		if files[2].Collapsed != "" || len(files[2].Rows) != 10 {
			t.Errorf("after.go = %q, want expanded despite following a huge file", files[2].Collapsed)
		}
		// RowCount is stamped even when collapsed: the virtualizer sizes the
		// placeholder from it.
		if files[1].RowCount != maxEagerRowsPerFile+1 {
			t.Errorf("RowCount = %d, want it stamped on a collapsed file", files[1].RowCount)
		}
	})

	t.Run("the whole-diff row budget stops expansion", func(t *testing.T) {
		var files []FileEntry
		for i := 0; i < 20; i++ {
			files = append(files, FileEntry{Path: "f.go", HasPatch: true, Patch: patchWithRows(400)})
		}
		applyEagerBudget(files)

		rows, expanded := 0, 0
		for _, f := range files {
			if f.Collapsed == "" {
				expanded++
				rows += f.RowCount
			} else if f.Collapsed != CollapsedBudget {
				t.Errorf("collapsed reason = %q, want %q", f.Collapsed, CollapsedBudget)
			}
		}
		if rows > maxEagerRows {
			t.Errorf("expanded %d rows, over the %d budget", rows, maxEagerRows)
		}
		if expanded == 0 || expanded == len(files) {
			t.Errorf("expanded %d of %d — want a prefix, not all or nothing", expanded, len(files))
		}
	})

	t.Run("the file-count cap bounds a PR of tiny files", func(t *testing.T) {
		var files []FileEntry
		for i := 0; i < maxEagerFiles+15; i++ {
			files = append(files, FileEntry{Path: "f.go", HasPatch: true, Patch: patchWithRows(3)})
		}
		applyEagerBudget(files)

		expanded := 0
		for _, f := range files {
			if f.Collapsed == "" {
				expanded++
			}
		}
		if expanded != maxEagerFiles {
			t.Errorf("expanded = %d, want the %d-file cap to bind before the row budget",
				expanded, maxEagerFiles)
		}
	})

	t.Run("a patchless file is left alone", func(t *testing.T) {
		files := []FileEntry{{Path: "logo.png", HasPatch: false}}
		applyEagerBudget(files)
		if files[0].Collapsed != "" || files[0].RowCount != 0 || files[0].Rows != nil {
			t.Errorf("binary file = %+v, want untouched — it renders a no-diff row", files[0])
		}
	})

	t.Run("eager rows carry TEXT, and now colour too", func(t *testing.T) {
		// This assertion used to read "text but NO colour", on the reasoning
		// that colour "costs a gh blob fetch". That reasoning was about the
		// NETWORK, and it still holds for the blob-backed rungs — but tier 0.5
		// lexes the patch's own text and fetches nothing, so the premise no
		// longer reaches it. The cold-fetch call-count guard elsewhere in this
		// file is what keeps the network promise honest; this one is about what
		// the rows carry.
		files := []FileEntry{{Path: "a.go", HasPatch: true, Patch: patchWithRows(5)}}
		applyEagerBudget(files)
		for _, row := range files[0].Rows {
			if row.Kind == RowHunk {
				continue
			}
			// Text is mandatory: a LineRow has no text field, so a row without
			// spans renders blank — the whole file would be line numbers over
			// empty rows.
			if len(row.Spans) == 0 {
				t.Fatal("eager row has no spans — it would render as a blank line")
			}
		}
	})
}

// A gh failure must never reach the tile's banner as a runtime string. The
// timeout case is the one that bit: exec.CommandContext SIGKILLs on a deadline,
// the process dies before writing stderr, and Go's "signal: killed" was being
// rendered verbatim to the reader.
func TestGhFailuresAreClassifiedNotLeaked(t *testing.T) {
	t.Run("rate limit is its own sentinel — the remedy is time, not retry", func(t *testing.T) {
		for _, stderr := range []string{
			"gh: API rate limit exceeded for user ID 301235013.",
			"You have exceeded a secondary rate limit",
			"was submitted too quickly",
		} {
			if !isRateLimit(stderr) {
				t.Errorf("isRateLimit(%q) = false", stderr)
			}
		}
		if isRateLimit("gh: Not Found") {
			t.Error("isRateLimit matched an unrelated failure")
		}
	})

	t.Run("firstLine keeps a banner to one line", func(t *testing.T) {
		if got := firstLine("boom\nusage: gh api\n  --method"); got != "boom" {
			t.Errorf("firstLine = %q, want the first line only", got)
		}
		if got := firstLine(""); got != "no output" {
			t.Errorf("firstLine(empty) = %q", got)
		}
	})
}

// A LineRow has no text field: content lives only in Spans. So structure built
// without them renders as line numbers and a +/- gutter over BLANK rows — which
// is exactly what the eagerly-expanded list path shipped, because
// applyEagerBudget calls diffrows.LineRowsFromPatch and nothing filled the text in.
//
// "Readable and monochrome" is the whole premise of opening the tile expanded;
// without this it opens empty.
func TestEagerRowsCarryTheirText(t *testing.T) {
	patch := strings.Join([]string{
		"@@ -1,2 +1,3 @@",
		" keep me",
		"-gone",
		"+added",
		"+",
	}, "\n")

	rows := diffrows.LineRowsFromPatch(diffrows.ParsePatch(patch))
	if len(rows) != 5 {
		t.Fatalf("rows = %d, want 5", len(rows))
	}

	if rows[0].Kind != RowHunk || rows[0].Spans != nil {
		t.Errorf("hunk header = %+v, want no spans (it renders from Header)", rows[0])
	}
	for i, want := range map[int]string{1: "keep me", 2: "gone", 3: "added"} {
		if len(rows[i].Spans) != 1 || rows[i].Spans[0].Text != want {
			t.Errorf("row %d spans = %+v, want one classless span %q", i, rows[i].Spans, want)
		}
		if rows[i].Spans[0].Class != "" {
			t.Errorf("row %d span carries a class %q — tier 0 is plain by definition",
				i, rows[i].Spans[0].Class)
		}
	}
	// An empty added line needs no span; the renderer draws an empty row.
	if rows[4].Spans != nil {
		t.Errorf("empty line spans = %+v, want nil", rows[4].Spans)
	}
}

// The budget path is what the tile actually mounts from, so assert the text
// survives all the way through it.
func TestEagerBudgetShipsReadableRows(t *testing.T) {
	files := []FileEntry{{
		Path: "a.go", HasPatch: true,
		Patch: "@@ -0,0 +1,2 @@\n+package main\n+// hi",
	}}
	applyEagerBudget(files)

	if files[0].Collapsed != "" {
		t.Fatalf("file collapsed = %q, want expanded", files[0].Collapsed)
	}
	// One string PER ROW, not per span: tier 0.5 splits a line into several
	// classed spans, so the line is their concatenation.
	var text []string
	for _, row := range files[0].Rows {
		if row.Kind == RowHunk {
			continue
		}
		var line string
		for _, span := range row.Spans {
			line += span.Text
		}
		text = append(text, line)
	}
	if len(text) != 2 || text[0] != "package main" || text[1] != "// hi" {
		t.Errorf("eager rows carry %q — an expanded file must not render blank", text)
	}
}

// GitHub bills a GraphQL query on the `first:` values it DECLARES, not the rows
// it returns, so a nested connection's bound is a fixed per-call price:
// (threads x comments)/100 + 1. At comments(first: 100) this query cost 101
// points on every tile mount — a page reload spent ~100 and ~36 reloads
// exhausted the hourly budget, taking the whole PR-status join with it.
//
// Measured against the live API while fixing it:
//
//	threads:100 comments:100 -> 101    threads:100 comments:20 -> 21
//	threads:100 comments:10  ->  11    threads: 50 comments:20 -> 11
func TestThreadsQueryBoundsTheNestedCommentConnection(t *testing.T) {
	if strings.Contains(threadsQuery, "comments(first: 100)") {
		t.Error("comments(first: 100) costs 101 points per mount — bound it; " +
			"the price is declared, not measured, so a small PR pays it too")
	}
	if !strings.Contains(threadsQuery, "comments(first: 20)") {
		t.Error("the comment bound moved; keep it small and say why in the query comment")
	}
	// Thread coverage stays wide on purpose: a truncated thread list hides
	// feedback entirely, where a truncated comment list hides the tail of a
	// conversation nobody reads in a side panel.
	if !strings.Contains(threadsQuery, "reviewThreads(first: 100)") {
		t.Error("thread coverage narrowed — a missing thread is invisible feedback")
	}
}

// THE CALL-COUNT GUARD.
//
// A cold document is TWO gh reads: the file list over REST (only REST carries
// patches) and one GraphQL call that answers threads, viewer AND the PR meta.
// The meta used to be a third read — `GET /repos/{o}/{r}/pulls/{n}` — costing
// ~0.65 s on the critical path for four scalars the GraphQL node already had.
//
// Assert the argv, because re-adding that call has no other symptom: the
// document would be identical and only the clock would know.
func TestColdFetchMakesTwoCallsAndNoMetaCall(t *testing.T) {
	f, calls := newRecordingFetcher(t, map[string]string{
		"/files": `[[{"filename":"a.go","status":"modified","patch":"@@ -1 +1 @@\n-a\n+b"}]]`,
		"graphql": `{"data":{"viewer":{"login":"me"},"repository":{"pullRequest":{
			"title":"T","state":"OPEN","headRefOid":"head1","baseRefOid":"base1",
			"reviewThreads":{"nodes":[]}}}}}`,
	})
	got, err := f.Get(context.Background(), "https://github.com/o/r/pull/7", false)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if len(*calls) != 2 {
		for _, c := range *calls {
			t.Logf("  call: %s", strings.Join(c.args, " "))
		}
		t.Fatalf("cold fetch made %d gh calls, want 2", len(*calls))
	}
	for _, c := range *calls {
		joined := strings.Join(c.args, " ")
		if strings.Contains(joined, "/pulls/7") && !strings.Contains(joined, "/files") {
			t.Errorf("the PR meta is being read on its own REST call again: %s", joined)
		}
	}
	// The meta reached the document off the GraphQL node.
	if got.Title != "T" || got.HeadSha != "head1" || got.BaseSha != "base1" {
		t.Errorf("meta = %q/%q/%q, want T/head1/base1", got.Title, got.HeadSha, got.BaseSha)
	}
	// GraphQL spells the enum uppercase; the wire contract is REST's lowercase.
	if got.State != "open" {
		t.Errorf("State = %q, want %q — GraphQL's OPEN must be normalised", got.State, "open")
	}
}

// The two reads must actually OVERLAP, not merely be written as goroutines.
// Each call blocks until the other has started; serial code cannot get past
// the first, so a regression here fails as a deadlock (the 15 s fetchBudget
// cancels it) rather than as a slow-but-passing test. Wall-clock assertions
// would be flaky in CI; this one is deterministic.
func TestTheTwoReadsRunConcurrently(t *testing.T) {
	arrived := make(chan struct{}, 2)
	release := make(chan struct{})
	f := NewFetcher()
	f.available = func(context.Context) bool { return true }
	f.ghExec = func(ctx context.Context, _ []byte, args ...string) ([]byte, error) {
		arrived <- struct{}{}
		select {
		case <-release:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
		if strings.Contains(strings.Join(args, " "), "graphql") {
			return []byte(`{"data":{"viewer":{"login":"me"},"repository":{"pullRequest":{
				"headRefOid":"h","reviewThreads":{"nodes":[]}}}}}`), nil
		}
		return []byte(`[[]]`), nil
	}

	done := make(chan error, 1)
	go func() {
		_, err := f.Get(context.Background(), "https://github.com/o/r/pull/7", false)
		done <- err
	}()

	deadline := time.After(5 * time.Second)
	for i := 0; i < 2; i++ {
		select {
		case <-arrived:
		case <-deadline:
			t.Fatalf("only %d of 2 reads had started; they are still serial", i)
		}
	}
	close(release)
	if err := <-done; err != nil {
		t.Fatalf("Get: %v", err)
	}
}

// Both reads share one ctx, so one budget expiry fails both. Which error the
// caller sees must not depend on which goroutine lost the race, or an identical
// failure would surface as a timeout on one run and a rate limit on the next.
func TestFetchReportsTheFilesErrorWhenBothFail(t *testing.T) {
	f := NewFetcher()
	f.available = func(context.Context) bool { return true }
	f.ghExec = func(_ context.Context, _ []byte, args ...string) ([]byte, error) {
		if strings.Contains(strings.Join(args, " "), "graphql") {
			return nil, errors.New("threads exploded")
		}
		return nil, errors.New("files exploded")
	}
	_, err := f.Get(context.Background(), "https://github.com/o/r/pull/7", false)
	if err == nil || !strings.Contains(err.Error(), "files exploded") {
		t.Fatalf("err = %v, want the files error", err)
	}
}

// R5 TIER 0.5 — colour on first paint, for no request at all.
//
// The rows the tile mounts from arrive coloured, lexed from the patch's own
// text. The blob-backed rungs still correct them as each file approaches the
// viewport; this is only about what the reader sees in the gap.
func TestEagerRowsArriveColoured(t *testing.T) {
	files := []FileEntry{{
		Path:     "a.go",
		HasPatch: true,
		Patch:    "@@ -1,3 +1,4 @@\n package main\n-var Old = 1\n+var New = 2\n+// trailing",
	}}
	applyEagerBudget(files)
	if files[0].Collapsed != "" {
		t.Fatalf("collapsed = %q, want expanded", files[0].Collapsed)
	}

	classed := 0
	for i, row := range files[0].Rows {
		if row.Kind == RowHunk {
			// The header renders from Header; spans there would be drawn twice.
			if len(row.Spans) != 0 {
				t.Errorf("hunk row %d carries spans %+v", i, row.Spans)
			}
			continue
		}
		for _, span := range row.Spans {
			if span.Class != "" {
				classed++
				break
			}
		}
	}
	if classed == 0 {
		t.Error("no row carried a token class — the .go lexer did not run over the patch text")
	}
}

// THE CORRUPTION GUARD, and the one that matters most here.
//
// Colouring rewrites a row's spans. If the lexer ever drops, reorders or
// duplicates a character, the reader sees WRONG CODE — not merely wrong colour
// — and nothing else in this suite would notice. So: concatenating a coloured
// row's spans must reproduce the tier-0 line exactly, byte for byte.
func TestColouringNeverChangesRowText(t *testing.T) {
	const patch = "@@ -1,5 +1,6 @@\n package main\n \n-func Old() string { return \"x\" }\n+func New() string { return \"héllo\\tworld\" }\n+// a comment with  double  spaces\n \t"
	plain := diffrows.LineRowsFromPatch(diffrows.ParsePatch(patch))
	want := make([]string, len(plain))
	for i, row := range plain {
		for _, span := range row.Spans {
			want[i] += span.Text
		}
	}

	files := []FileEntry{{Path: "a.go", HasPatch: true, Patch: patch}}
	applyEagerBudget(files)
	got := files[0].Rows
	if len(got) != len(plain) {
		t.Fatalf("coloured rows = %d, plain rows = %d", len(got), len(plain))
	}
	for i := range got {
		var joined string
		for _, span := range got[i].Spans {
			joined += span.Text
		}
		if joined != want[i] {
			t.Errorf("row %d text = %q after colouring, want %q", i, joined, want[i])
		}
	}
}

// A file no Chroma lexer matches keeps its tier-0 plain rows. That is the
// common case (lockfiles, data), and the ladder degrades to absent colour, not
// to an error or to a blank row.
func TestAFileWithNoLexerStaysPlain(t *testing.T) {
	files := []FileEntry{{
		Path:     "go.sum.lock.unknownext",
		HasPatch: true,
		Patch:    "@@ -1 +1 @@\n-a\n+b",
	}}
	applyEagerBudget(files)
	for i, row := range files[0].Rows {
		if row.Kind == RowHunk {
			continue
		}
		if len(row.Spans) != 1 || row.Spans[0].Class != "" {
			t.Errorf("row %d = %+v, want one classless span", i, row.Spans)
		}
		if row.Spans[0].Text == "" {
			t.Errorf("row %d lost its text", i)
		}
	}
}

// A collapsed file is never lexed: it has no rows, and spending the pass on it
// is exactly what the budget exists to avoid.
func TestCollapsedFilesAreNotColoured(t *testing.T) {
	big := "@@ -1,600 +1,600 @@\n" + strings.Repeat(" ctx\n", maxEagerRowsPerFile+10)
	files := []FileEntry{{Path: "big.go", HasPatch: true, Patch: big}}
	applyEagerBudget(files)
	if files[0].Collapsed != CollapsedLarge {
		t.Fatalf("collapsed = %q, want %q", files[0].Collapsed, CollapsedLarge)
	}
	if len(files[0].Rows) != 0 {
		t.Errorf("a collapsed file shipped %d rows", len(files[0].Rows))
	}
}
