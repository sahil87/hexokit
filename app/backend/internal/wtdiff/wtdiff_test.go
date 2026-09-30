package wtdiff

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// The fixture is REAL `git status --porcelain=v1 -z` output, captured from a
// repo staged to produce every case at once. The NUL layout is the whole point
// of the test, so it is spelled out rather than built by a helper.
const statusFixture = " D gone.txt\x00 M keep.txt\x00R  newname.txt\x00renamed.txt\x00A  staged.txt\x00?? untracked.txt\x00"

// THE PHASE GUARD.
//
// A rename emits its OLD path as a SECOND NUL-terminated field. A parser that
// does not consume it reads "renamed.txt" as the next record's status code and
// every file after the rename comes out wrong — which is silent, because the
// output is still a plausible-looking list.
func TestParseStatusConsumesTheRenameSourceField(t *testing.T) {
	got := parseStatus(statusFixture)
	want := []FileEntry{
		{Path: "gone.txt", Status: StatusRemoved, Staged: false},
		{Path: "keep.txt", Status: StatusModified, Staged: false},
		{Path: "newname.txt", Status: StatusRenamed, Staged: true, PreviousPath: "renamed.txt"},
		{Path: "staged.txt", Status: StatusAdded, Staged: true},
		{Path: "untracked.txt", Status: StatusUntracked, Staged: false},
	}
	if len(got) != len(want) {
		for _, g := range got {
			t.Logf("  %+v", g)
		}
		t.Fatalf("parsed %d entries, want %d — the rename source field shifted the loop", len(got), len(want))
	}
	for i := range want {
		if got[i].Path != want[i].Path || got[i].Status != want[i].Status ||
			got[i].Staged != want[i].Staged || got[i].PreviousPath != want[i].PreviousPath {
			t.Errorf("entry %d = %+v, want %+v", i, got[i], want[i])
		}
	}
}

// `??` is not a staged change, however tempting the non-space column looks.
func TestUntrackedIsNeverStaged(t *testing.T) {
	got := parseStatus("?? a.txt\x00")
	if len(got) != 1 || got[0].Staged {
		t.Fatalf("got %+v, want one unstaged untracked entry", got)
	}
}

// Real `git diff HEAD -M` output over the same repo.
const diffFixture = `diff --git a/gone.txt b/gone.txt
deleted file mode 100644
index 587be6b..0000000
--- a/gone.txt
+++ /dev/null
@@ -1 +0,0 @@
-x
diff --git a/keep.txt b/keep.txt
index de98044..7be73ce 100644
--- a/keep.txt
+++ b/keep.txt
@@ -1,3 +1,3 @@
 a
-b
+B
 c
diff --git a/renamed.txt b/newname.txt
similarity index 100%
rename from renamed.txt
rename to newname.txt
diff --git a/staged.txt b/staged.txt
new file mode 100644
index 0000000..3762249
--- /dev/null
+++ b/staged.txt
@@ -0,0 +1 @@
+S
`

func TestSplitPatchesKeysByPostImageAndTrimsToHunks(t *testing.T) {
	got := splitPatches(diffFixture)

	// A modification keys by its path and starts at the first @@ — which is
	// what makes the input shape identical to GitHub's REST `patch` field, so
	// the shipped ParsePatch needs no change to read git.
	keep, ok := got["keep.txt"]
	if !ok {
		t.Fatalf("keep.txt missing; got keys %v", keys(got))
	}
	if !strings.HasPrefix(keep, "@@ -1,3 +1,3 @@") {
		t.Errorf("keep.txt patch = %q, want it to start at the hunk header", keep)
	}
	if strings.Contains(keep, "index de98044") {
		t.Error("extended headers survived into the patch body")
	}

	// A deletion has no post image; it must still be found, under its own path.
	if _, ok := got["gone.txt"]; !ok {
		t.Errorf("a deleted file was dropped; got keys %v", keys(got))
	}
	// A pure rename has no hunks at all. It records with an empty patch, which
	// the client renders as "no diff available" rather than as an empty diff.
	if body, ok := got["newname.txt"]; !ok || body != "" {
		t.Errorf("pure rename = (%q, %v), want present and empty", body, ok)
	}
	if add := got["staged.txt"]; !strings.HasPrefix(add, "@@ -0,0 +1 @@") {
		t.Errorf("staged add = %q", add)
	}
}

func keys(m map[string]string) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}

// END TO END against a real repository. The parsers above are pinned to
// captured fixtures, which is exactly what goes stale when git changes its
// output; this proves the fixtures still describe reality.
func TestReadAgainstARealRepository(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not on PATH")
	}
	root := t.TempDir()
	run := func(args ...string) {
		t.Helper()
		cmd := exec.Command("git", append([]string{"-C", root}, args...)...)
		cmd.Env = append(os.Environ(),
			"GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@t",
			"GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@t")
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
	write := func(name, body string) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(root, name), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	run("init", "-q", ".")
	write("keep.go", "package a\n\nfunc A() int { return 1 }\n")
	write("gone.txt", "x\n")
	run("add", "-A")
	run("commit", "-qm", "base")

	write("keep.go", "package a\n\nfunc A() int { return 2 }\n")
	if err := os.Remove(filepath.Join(root, "gone.txt")); err != nil {
		t.Fatal(err)
	}
	write("fresh.go", "package a\n\nvar Fresh = true\n")

	snap, err := NewReader().Read(context.Background(), root)
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if snap.Clean {
		t.Fatal("Clean on a dirty tree")
	}
	byPath := map[string]FileEntry{}
	for _, f := range snap.Files {
		byPath[f.Path] = f
	}

	keep, ok := byPath["keep.go"]
	if !ok || keep.Status != StatusModified {
		t.Fatalf("keep.go = %+v", keep)
	}
	if len(keep.Rows) == 0 {
		t.Fatal("a modified file inside the eager budget shipped no rows")
	}
	// Colour comes from the rows themselves — no blob fetch, because the post
	// image IS the file on disk.
	coloured := false
	for _, row := range keep.Rows {
		for _, span := range row.Spans {
			if span.Class != "" {
				coloured = true
			}
		}
	}
	if !coloured {
		t.Error("no row carried a token class; the .go lexer did not run")
	}

	if gone, ok := byPath["gone.txt"]; !ok || gone.Status != StatusRemoved {
		t.Errorf("gone.txt = %+v, want removed", gone)
	}
	fresh, ok := byPath["fresh.go"]
	if !ok || fresh.Status != StatusUntracked {
		t.Fatalf("fresh.go = %+v, want untracked", fresh)
	}
	// An untracked file renders as an all-added patch. `git diff --no-index`
	// exits 1 on success, so this is also the guard that the runner does not
	// treat that as a failure.
	if !fresh.HasPatch || len(fresh.Rows) == 0 {
		t.Errorf("untracked file shipped no rows: %+v", fresh)
	}

	// A clean tree is not an error, and not an absent lens.
	run("add", "-A")
	run("commit", "-qm", "all")
	clean, err := NewReader().Read(context.Background(), root)
	if err != nil {
		t.Fatalf("Read on a clean tree: %v", err)
	}
	if !clean.Clean || len(clean.Files) != 0 {
		t.Errorf("clean tree = %+v", clean)
	}
}

// The budget bounds RENDER cost, which does not care that the rows were cheap
// to fetch.
func TestEagerBudgetCollapsesOversizeFiles(t *testing.T) {
	big := "@@ -1," + itoa(maxEagerRowsPerFile+10) + " +1," + itoa(maxEagerRowsPerFile+10) + " @@\n" +
		strings.Repeat(" ctx\n", maxEagerRowsPerFile+10)
	files := []FileEntry{
		{Path: "big.txt", HasPatch: true, patch: big},
		{Path: "small.txt", HasPatch: true, patch: "@@ -1 +1 @@\n-a\n+b\n"},
	}
	applyEagerBudget(files)
	if files[0].Collapsed != CollapsedLarge {
		t.Errorf("big.txt collapsed = %q, want %q", files[0].Collapsed, CollapsedLarge)
	}
	if len(files[0].Rows) != 0 {
		t.Error("a collapsed file shipped rows")
	}
	if files[0].RowCount == 0 {
		t.Error("a collapsed file must still carry RowCount so the scrollbar is right")
	}
	if files[1].Collapsed != "" || len(files[1].Rows) == 0 {
		t.Errorf("small.txt = %+v, want expanded", files[1])
	}
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var b []byte
	for n > 0 {
		b = append([]byte{byte('0' + n%10)}, b...)
		n /= 10
	}
	return string(b)
}

// THE DIGEST GUARD.
//
// A digest that misses a change is worse than no digest: the tile sits there
// showing stale code and nothing ever tells it. Each case below is a change a
// cheaper fingerprint would have missed, and the last two are why this one
// hashes the diff and stats untracked files rather than hashing `git status`.
func TestDigestMovesOnEveryChangeThatAltersTheTile(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not on PATH")
	}
	root := t.TempDir()
	run := func(args ...string) {
		t.Helper()
		cmd := exec.Command("git", append([]string{"-C", root}, args...)...)
		cmd.Env = append(os.Environ(),
			"GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@t",
			"GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@t")
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
	write := func(name, body string) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(root, name), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	reader := NewReader()
	digest := func() string {
		t.Helper()
		got, err := reader.Digest(context.Background(), root)
		if err != nil {
			t.Fatalf("Digest: %v", err)
		}
		return got
	}

	run("init", "-q", ".")
	write("a.go", "package a\n\nfunc A() int { return 1 }\n")
	run("add", "-A")
	run("commit", "-qm", "base")

	clean := digest()
	if clean == "" {
		t.Fatal("empty digest")
	}
	if again := digest(); again != clean {
		t.Fatalf("digest is not stable on an unchanged tree: %q then %q", clean, again)
	}

	steps := []struct {
		name string
		do   func()
	}{
		{"a tracked file is modified", func() { write("a.go", "package a\n\nfunc A() int { return 2 }\n") }},
		// THE CASE A STATUS HASH MISSES. The file was already modified, so the
		// porcelain output is byte-identical before and after this edit —
		// verified directly against git. Only hashing the diff sees it.
		{"an ALREADY-modified file is edited again", func() { write("a.go", "package a\n\nfunc A() int { return 3 }\n") }},
		{"a new untracked file appears", func() { write("new.txt", "one\n") }},
		// THE SECOND CASE A DIFF HASH MISSES. An untracked file's content is in
		// neither the status output nor `git diff HEAD`; its stat stands in.
		{"an untracked file's content changes", func() { write("new.txt", "one\ntwo\n") }},
		{"a change is staged", func() { run("add", "a.go") }},
		{"a file is deleted", func() { os.Remove(filepath.Join(root, "a.go")) }},
	}
	prev := clean
	for _, step := range steps {
		step.do()
		got := digest()
		if got == prev {
			t.Errorf("digest did not move when %s — the tile would show stale content", step.name)
		}
		prev = got
	}

	// And it comes back: committing everything returns the tree to a state the
	// digest already described, so it must read the same as it did then.
	run("add", "-A")
	run("commit", "-qm", "all")
	if got := digest(); got != clean {
		t.Errorf("a committed tree digests %q, want the original clean %q", got, clean)
	}
}

// Read's snapshot carries the same digest a bare Digest() call answers, so the
// client's first poll after a load cannot spuriously report a change.
func TestSnapshotDigestMatchesTheDigestCall(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not on PATH")
	}
	root := t.TempDir()
	cmd := exec.Command("git", "-C", root, "init", "-q", ".")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("init: %v\n%s", err, out)
	}
	if err := os.WriteFile(filepath.Join(root, "x.txt"), []byte("hi\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	reader := NewReader()
	snap, err := reader.Read(context.Background(), root)
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	standalone, err := reader.Digest(context.Background(), root)
	if err != nil {
		t.Fatalf("Digest: %v", err)
	}
	if snap.Digest != standalone {
		t.Errorf("snapshot digest %q != Digest() %q — the first poll would refetch for nothing",
			snap.Digest, standalone)
	}
}
