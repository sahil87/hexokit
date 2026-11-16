package operator

import (
	"fmt"
	"strings"
	"testing"
	"time"
)

func noteFixture(t *testing.T) string {
	t.Helper()
	path := seededState(t, "")
	stubSeams(t)
	mustAdd(t, path, AddSpec{ID: "n1", Kind: KindNote, Text: "seed", TextSet: true})
	return path
}

func TestAddNote_AppendsInOrderAndTouchesUpdatedAt(t *testing.T) {
	path := noteFixture(t)
	stubClock(t)
	before := item(t, path, "n1")

	if err := AddNote(path, "n1", ByChat, "  second note \n"); err != nil {
		t.Fatal(err)
	}
	it := item(t, path, "n1")
	if len(it.Notes) != 2 {
		t.Fatalf("notes = %+v", it.Notes)
	}
	last := it.Notes[1]
	if last.By != ByChat || last.Text != "second note" {
		t.Errorf("note = %+v, want chat/%q (trimmed)", last, "second note")
	}
	if _, err := time.Parse(time.RFC3339, last.At); err != nil {
		t.Errorf("note at %q not RFC3339", last.At)
	}
	if it.UpdatedAt == before.UpdatedAt || it.UpdatedAt != last.At {
		t.Errorf("updated_at = %s, want bumped to the note's at %s", it.UpdatedAt, last.At)
	}
}

func TestAddNote_PrunesOldestPastTheCap(t *testing.T) {
	path := noteFixture(t)
	for i := 1; i < NoteCap; i++ {
		if err := AddNote(path, "n1", ByUser, fmt.Sprintf("note %d", i)); err != nil {
			t.Fatal(err)
		}
	}
	it := item(t, path, "n1")
	if len(it.Notes) != NoteCap || it.Notes[0].Text != "seed" {
		t.Fatalf("setup: %d notes, first %q", len(it.Notes), it.Notes[0].Text)
	}

	if err := AddNote(path, "n1", ByUser, "the 51st"); err != nil {
		t.Fatal(err)
	}
	it = item(t, path, "n1")
	if len(it.Notes) != NoteCap {
		t.Fatalf("notes = %d, want the %d cap", len(it.Notes), NoteCap)
	}
	if it.Notes[0].Text != "note 1" {
		t.Errorf("oldest = %q, want the seed pruned", it.Notes[0].Text)
	}
	if it.Notes[NoteCap-1].Text != "the 51st" {
		t.Errorf("newest = %q, want the 51st last", it.Notes[NoteCap-1].Text)
	}
}

func TestAddNote_RuneCap(t *testing.T) {
	path := noteFixture(t)

	// Exactly the cap in multibyte runes passes: the cap counts runes, not bytes.
	if err := AddNote(path, "n1", ByUser, strings.Repeat("é", NoteTextCap)); err != nil {
		t.Fatalf("a %d-rune note was rejected: %v", NoteTextCap, err)
	}
	err := AddNote(path, "n1", ByUser, strings.Repeat("x", NoteTextCap+1))
	wantErr(t, err, "over the 1000-character cap")
	if !isInvalid(err) {
		t.Error("an over-length note must be a usage error")
	}
	for _, n := range item(t, path, "n1").Notes {
		if strings.Count(n.Text, "x") > 0 {
			t.Error("an over-length note was stored (or truncated)")
		}
	}
}

func TestAddNote_ValidatesAuthorAndText(t *testing.T) {
	path := noteFixture(t)
	for _, tc := range []struct {
		by, text, want string
	}{
		{"robot", "hi", `invalid --by "robot"`},
		{"", "hi", "invalid --by"},
		{ByUser, "   \n\t", "must not be empty"},
		{ByUser, "", "must not be empty"},
	} {
		err := AddNote(path, "n1", tc.by, tc.text)
		wantErr(t, err, tc.want)
		if !isInvalid(err) {
			t.Errorf("AddNote(%q, %q): want a usage error", tc.by, tc.text)
		}
	}
	if got := len(item(t, path, "n1").Notes); got != 1 {
		t.Errorf("notes = %d after rejected appends, want 1", got)
	}
	wantErr(t, AddNote(path, "zz", ByUser, "hi"), "no tracked item zz")
}

func TestNotes_AttachToAnyKind(t *testing.T) {
	path := seededState(t, seedShell)
	if err := AddNote(path, "pr-1", ByRun, "ran the probe by hand"); err != nil {
		t.Fatal(err)
	}
	if got := item(t, path, "pr-1").Notes; len(got) != 1 || got[0].By != ByRun {
		t.Errorf("notes = %+v", got)
	}
}

func TestRemove_TakesTheNotesWithTheItem(t *testing.T) {
	path := noteFixture(t)
	if err := Remove(path, "n1"); err != nil {
		t.Fatal(err)
	}
	if st := mustLoad(t, path); len(st.Tracked) != 0 {
		t.Errorf("tracked = %+v", st.Tracked)
	}
}

func TestSchemaHasNoTextOrClockOverride(t *testing.T) {
	path := noteFixture(t)
	st := mustLoad(t, path)
	out, err := st.marshal()
	if err != nil {
		t.Fatal(err)
	}
	for _, banned := range []string{"clock_override", "\n    text:"} {
		if strings.Contains(string(out), banned) {
			t.Errorf("serialized state contains %q:\n%s", banned, out)
		}
	}
	if !strings.Contains(string(out), "notes:") {
		t.Errorf("serialized state lacks notes:\n%s", out)
	}
}
