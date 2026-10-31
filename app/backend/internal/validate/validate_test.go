package validate

import (
	"os"
	"strings"
	"testing"
	"unicode/utf8"
)

func TestValidateName(t *testing.T) {
	tests := []struct {
		name     string
		input    string
		label    string
		wantErr  bool
		contains string
	}{
		{"valid name", "my-session", "Session name", false, ""},
		{"alphanumeric with hyphens/underscores", "test_session-123", "Name", false, ""},
		{"empty string", "", "Session name", true, "cannot be empty"},
		{"whitespace only", "   ", "Session name", true, "cannot be empty"},
		{"forbidden semicolon", "my;session", "Name", true, "forbidden characters"},
		{"forbidden ampersand", "my&session", "Name", true, "forbidden characters"},
		{"forbidden pipe", "my|session", "Name", true, "forbidden characters"},
		{"forbidden backtick", "my`session", "Name", true, "forbidden characters"},
		{"forbidden dollar", "my$session", "Name", true, "forbidden characters"},
		{"exceeds max length", string(make([]byte, 129)), "Name", true, "maximum length"},
		{"at max length", string(make([]byte, 128)), "Name", false, ""},
		{"contains colon", "my:session", "Name", true, "colons or periods"},
		{"contains period", "my.session", "Name", true, "colons or periods"},
		{"label in error", "", "Window name", true, "Window name"},
	}

	// Fill the max/over-max names with 'a'
	for i := range tests {
		if tests[i].name == "exceeds max length" {
			b := make([]byte, 129)
			for j := range b {
				b[j] = 'a'
			}
			tests[i].input = string(b)
		}
		if tests[i].name == "at max length" {
			b := make([]byte, 128)
			for j := range b {
				b[j] = 'a'
			}
			tests[i].input = string(b)
		}
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := ValidateName(tt.input, tt.label)
			if tt.wantErr && result == "" {
				t.Error("expected error but got none")
			}
			if !tt.wantErr && result != "" {
				t.Errorf("expected no error but got: %s", result)
			}
			if tt.contains != "" && result == "" {
				t.Errorf("expected error containing %q but got none", tt.contains)
			}
			if tt.contains != "" && result != "" {
				if !contains(result, tt.contains) {
					t.Errorf("expected error containing %q but got: %s", tt.contains, result)
				}
			}
		})
	}
}

func TestValidateWindowID(t *testing.T) {
	tests := []struct {
		name     string
		input    string
		label    string
		wantErr  bool
		contains string
	}{
		{"valid single digit", "@5", "Window ID", false, ""},
		{"valid multi digit", "@123", "Window ID", false, ""},
		{"valid zero", "@0", "Window ID", false, ""},
		{"empty string", "", "Window ID", true, "cannot be empty"},
		{"missing at sign", "5", "Window ID", true, "@N"},
		{"at sign only", "@", "Window ID", true, "@N"},
		{"injection attempt", "@5;rm", "Window ID", true, "@N"},
		{"non-numeric suffix", "window-5", "Window ID", true, "@N"},
		{"trailing space", "@5 ", "Window ID", true, "@N"},
		{"label in error", "bogus", "Window ID", true, "Window ID"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := ValidateWindowID(tt.input, tt.label)
			if tt.wantErr && result == "" {
				t.Error("expected error but got none")
			}
			if !tt.wantErr && result != "" {
				t.Errorf("expected no error but got: %s", result)
			}
			if tt.contains != "" && result == "" {
				t.Errorf("expected error containing %q but got none", tt.contains)
			}
			if tt.contains != "" && result != "" {
				if !contains(result, tt.contains) {
					t.Errorf("expected error containing %q but got: %s", tt.contains, result)
				}
			}
		})
	}
}

func TestValidatePath(t *testing.T) {
	tests := []struct {
		name     string
		input    string
		label    string
		wantErr  bool
		contains string
	}{
		{"valid path", "/home/user/project", "Path", false, ""},
		{"empty string", "", "Path", true, "cannot be empty"},
		{"null bytes", "/home/\x00evil", "Path", true, "invalid characters"},
		{"newlines", "/home/\nevil", "Path", true, "invalid characters"},
		{"exceeds max length", "/" + string(make([]byte, 1024)), "Path", true, "maximum length"},
	}

	// Fill the over-max path with 'a'
	for i := range tests {
		if tests[i].name == "exceeds max length" {
			b := make([]byte, 1024)
			for j := range b {
				b[j] = 'a'
			}
			tests[i].input = "/" + string(b)
		}
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := ValidatePath(tt.input, tt.label)
			if tt.wantErr && result == "" {
				t.Error("expected error but got none")
			}
			if !tt.wantErr && result != "" {
				t.Errorf("expected no error but got: %s", result)
			}
		})
	}
}

func TestExpandTilde(t *testing.T) {
	home, _ := os.UserHomeDir()

	tests := []struct {
		name        string
		input       string
		wantPath    string
		wantErr     bool
		errContains string
	}{
		{"tilde alone", "~", home, false, ""},
		{"tilde path", "~/code/project", home + "/code/project", false, ""},
		{"bare relative", "code/project", home + "/code/project", false, ""},
		{"absolute under home", home + "/code/project", home + "/code/project", false, ""},
		{"dot-dot escape", "~/../../etc", "", true, "under home directory"},
		{"absolute outside home", "/etc/passwd", "", true, "under home directory"},
		{"tilde username", "~root", "", true, "~user expansion is not supported"},
		{"tilde other user path", "~otheruser/secret", "", true, "~user expansion is not supported"},
		{"home itself", home, home, false, ""},
		{"dot-dot within home", "~/code/../code/project", home + "/code/project", false, ""},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			path, errMsg := ExpandTilde(tt.input)
			if tt.wantErr {
				if errMsg == "" {
					t.Error("expected error but got none")
				}
				if tt.errContains != "" && !contains(errMsg, tt.errContains) {
					t.Errorf("expected error containing %q but got: %s", tt.errContains, errMsg)
				}
			} else {
				if errMsg != "" {
					t.Errorf("expected no error but got: %s", errMsg)
				}
				if path != tt.wantPath {
					t.Errorf("expected path %q but got %q", tt.wantPath, path)
				}
			}
		})
	}
}

func TestSanitizeFilename(t *testing.T) {
	tests := []struct {
		name  string
		input string
		want  string
	}{
		{"simple filename", "screenshot.png", "screenshot.png"},
		{"forward slashes", "path/to/file.txt", "path-to-file.txt"},
		{"backslashes", "path\\to\\file.txt", "path-to-file.txt"},
		{"null bytes", "file\x00name.txt", "filename.txt"},
		{"leading dots", ".hidden", "hidden"},
		{"triple dots", "...triple", "triple"},
		{"path traversal", "../../../etc/passwd", "etc-passwd"},
		{"backslash traversal", "..\\..\\..\\etc\\passwd", "etc-passwd"},
		{"collapse dashes", "a---b", "a-b"},
		{"strip edges", "-file-", "file"},
		{"empty string", "", "upload"},
		{"dots only", "...", "upload"},
		{"slashes only", "///", "upload"},
		{"preserves extension", "my-document.pdf", "my-document.pdf"},
		{"spaces in name", "my file name.png", "my file name.png"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := SanitizeFilename(tt.input)
			if got != tt.want {
				t.Errorf("SanitizeFilename(%q) = %q, want %q", tt.input, got, tt.want)
			}
		})
	}
}

func contains(s, substr string) bool {
	return len(s) >= len(substr) && (s == substr || len(s) > 0 && containsStr(s, substr))
}

func containsStr(s, sub string) bool {
	for i := 0; i <= len(s)-len(sub); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}

func TestValidateTier(t *testing.T) {
	tests := []struct {
		name     string
		input    string
		wantErr  bool
		contains string
	}{
		{"valid simple", "doing", false, ""},
		{"valid alphanumeric", "review2", false, ""},
		{"valid with hyphen", "my-tier", false, ""},
		{"valid with underscore", "my_tier", false, ""},
		{"valid leading underscore", "_tier", false, ""},
		{"valid single char", "d", false, ""},
		{"empty is rejected by the pattern", "", true, "alphanumeric"},
		{"leading hyphen rejected", "-doing", true, "must not start with a hyphen"},
		{"forbidden space", "a b", true, "alphanumeric"},
		{"forbidden slash", "a/b", true, "alphanumeric"},
		{"forbidden semicolon", "a;b", true, "alphanumeric"},
		{"forbidden dollar", "a$b", true, "alphanumeric"},
		{"at max length", "", false, ""},                   // filled below
		{"exceeds max length", "", true, "maximum length"}, // filled below
	}

	// Fill the max/over-max cases with 'a' (kept valid-charset so the length
	// bound, not the pattern, is the failing rule).
	for i := range tests {
		if tests[i].name == "at max length" {
			b := make([]byte, MaxTierNameLength)
			for j := range b {
				b[j] = 'a'
			}
			tests[i].input = string(b)
		}
		if tests[i].name == "exceeds max length" {
			b := make([]byte, MaxTierNameLength+1)
			for j := range b {
				b[j] = 'a'
			}
			tests[i].input = string(b)
		}
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := ValidateTier(tt.input)
			if tt.wantErr && result == "" {
				t.Errorf("ValidateTier(%q) = valid, want error", tt.input)
			}
			if !tt.wantErr && result != "" {
				t.Errorf("ValidateTier(%q) = %q, want valid", tt.input, result)
			}
			if tt.contains != "" && result != "" && !contains(result, tt.contains) {
				t.Errorf("ValidateTier(%q) = %q, want error containing %q", tt.input, result, tt.contains)
			}
		})
	}
}

func TestValidateToolName(t *testing.T) {
	tests := []struct {
		name     string
		input    string
		wantErr  bool
		contains string
	}{
		{"valid run-kit", "run-kit", false, ""},
		{"valid fab-kit", "fab-kit", false, ""},
		{"valid short tu", "tu", false, ""},
		{"valid wt", "wt", false, ""},
		{"valid alphanumeric", "tool2", false, ""},
		{"valid underscore", "my_tool", false, ""},
		{"valid leading underscore", "_tool", false, ""},
		{"empty rejected", "", true, "cannot be empty"},
		{"leading hyphen rejected (flag injection)", "-rf", true, "must not start with a hyphen"},
		{"leading double-hyphen rejected", "--force", true, "must not start with a hyphen"},
		{"forbidden space", "run kit", true, "alphanumeric"},
		{"forbidden tab", "run\tkit", true, "alphanumeric"},
		{"forbidden newline", "run\nkit", true, "alphanumeric"},
		{"forbidden semicolon", "a;b", true, "alphanumeric"},
		{"forbidden dollar", "a$b", true, "alphanumeric"},
		{"at max length", "", false, ""},                   // filled below
		{"exceeds max length", "", true, "maximum length"}, // filled below
	}

	for i := range tests {
		if tests[i].name == "at max length" {
			b := make([]byte, MaxToolNameLength)
			for j := range b {
				b[j] = 'a'
			}
			tests[i].input = string(b)
		}
		if tests[i].name == "exceeds max length" {
			b := make([]byte, MaxToolNameLength+1)
			for j := range b {
				b[j] = 'a'
			}
			tests[i].input = string(b)
		}
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := ValidateToolName(tt.input)
			if tt.wantErr && result == "" {
				t.Errorf("ValidateToolName(%q) = valid, want error", tt.input)
			}
			if !tt.wantErr && result != "" {
				t.Errorf("ValidateToolName(%q) = %q, want valid", tt.input, result)
			}
			if tt.contains != "" && result != "" && !contains(result, tt.contains) {
				t.Errorf("ValidateToolName(%q) = %q, want error containing %q", tt.input, result, tt.contains)
			}
		})
	}
}

func TestValidateNewName(t *testing.T) {
	tests := []struct {
		name     string
		input    string
		label    string
		wantErr  bool
		contains string
	}{
		// The tightened rule: spaces rejected on NEW names.
		{"space rejected", "My problem", "Session name", true, "cannot contain spaces"},
		{"leading space rejected", " name", "Session name", true, "cannot contain spaces"},
		{"trailing space rejected", "name ", "Session name", true, "cannot contain spaces"},
		{"label in space error", "a b", "Window name", true, "Window name"},
		// Inherited from the permissive ValidateName rule.
		{"empty rejected", "", "Session name", true, "cannot be empty"},
		{"forbidden semicolon", "my;session", "Session name", true, "forbidden characters"},
		{"contains colon", "my:session", "Session name", true, "colons or periods"},
		{"contains period", "my.session", "Session name", true, "colons or periods"},
		// Hyphens stay legal on the backend (UI-only steering): internal
		// sessions (_rk-pin-*, rk-test-e2e, group names) rely on them.
		{"hyphens allowed", "my-session", "Session name", false, ""},
		{"underscores allowed", "My_problem", "Session name", false, ""},
		{"alphanumeric allowed", "session123", "Session name", false, ""},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := ValidateNewName(tt.input, tt.label)
			if tt.wantErr && result == "" {
				t.Errorf("ValidateNewName(%q) = valid, want error", tt.input)
			}
			if !tt.wantErr && result != "" {
				t.Errorf("ValidateNewName(%q) = %q, want valid", tt.input, result)
			}
			if tt.contains != "" && result != "" && !contains(result, tt.contains) {
				t.Errorf("ValidateNewName(%q) = %q, want error containing %q", tt.input, result, tt.contains)
			}
		})
	}
}

// TestValidateNewNameMaxLength pins that the length bound is inherited from
// ValidateName (128), not redefined.
func TestValidateNewNameMaxLength(t *testing.T) {
	long := make([]byte, 129)
	for i := range long {
		long[i] = 'a'
	}
	if result := ValidateNewName(string(long), "Session name"); result == "" {
		t.Error("expected max-length error, got valid")
	}
	if result := ValidateNewName(string(long[:128]), "Session name"); result != "" {
		t.Errorf("128-char name should be valid, got %q", result)
	}
}

func TestValidateWorktreeName(t *testing.T) {
	tests := []struct {
		name     string
		input    string
		wantErr  bool
		contains string
	}{
		{"valid simple", "swift-fox", false, ""},
		{"valid with underscore", "my_agent", false, ""},
		{"valid alphanumeric", "agent123", false, ""},
		// Inherited from the shared ValidateName rule (deliberately unchanged).
		{"empty rejected", "", true, "cannot be empty"},
		{"forbidden semicolon", "bad;name", true, "forbidden characters"},
		{"forbidden dollar", "bad$name", true, "forbidden characters"},
		{"contains colon", "bad:name", true, "colons or periods"},
		{"contains period", "bad.name", true, "colons or periods"},
		// riff-seam-only hardening (NOT applied by the shared ValidateName).
		{"leading hyphen rejected", "-agent", true, "must not start with a hyphen"},
		{"slash rejected", "a/b", true, "must not contain a slash"},
		{"space rejected", "a b", true, "must not contain spaces"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := ValidateWorktreeName(tt.input)
			if tt.wantErr && result == "" {
				t.Errorf("ValidateWorktreeName(%q) = valid, want error", tt.input)
			}
			if !tt.wantErr && result != "" {
				t.Errorf("ValidateWorktreeName(%q) = %q, want valid", tt.input, result)
			}
			if tt.contains != "" && result != "" && !contains(result, tt.contains) {
				t.Errorf("ValidateWorktreeName(%q) = %q, want error containing %q", tt.input, result, tt.contains)
			}
		})
	}
}

func TestValidateColorValue(t *testing.T) {
	// Canonical and whitespace-tolerant numeric forms (parts are trimmed,
	// matching the frontend parseColorValue), plus leading-zero indices. The
	// legacy numeric vocabulary remains valid forever (read + write).
	valid := []string{"0", "4", "15", "1+3", "0+15", "1+2", " 4 ", " 1 + 3 ", "01"}
	// The owned-palette family-name vocabulary: all 10 names + their -dark and
	// -light shade variants (surrounding whitespace tolerated, matching the
	// frontend resolveFamily trim rule).
	families := []string{"red", "orange", "amber", "olive", "green", "teal", "blue", "purple", "magenta", "slate"}
	for _, f := range families {
		valid = append(valid, f, f+"-dark", f+"-light")
	}
	valid = append(valid, " blue-dark ", " blue-light ")
	for _, v := range valid {
		if msg := ValidateColorValue(v); msg != "" {
			t.Errorf("ValidateColorValue(%q) = %q, want valid", v, msg)
		}
	}
	// Empty parts are rejected explicitly; "1 3" (space, no '+') is one part and
	// fails strconv after trimming. Family near-misses (unknown names, wrong
	// shade suffix, case variants — the frontend only writes canonical names)
	// are rejected.
	invalid := []string{
		"", "99", "-1", "16", "x", "1+", "+3", "1+2+3", "1.5", "1 3", "  +  ", "1 + ",
		"bluish", "bluish-light", "blue-lite", "Blue", "BLUE-DARK", "blue+red", "-dark", "dark", "-light", "light", "1+3-light",
	}
	for _, v := range invalid {
		if msg := ValidateColorValue(v); msg == "" {
			t.Errorf("ValidateColorValue(%q) = valid, want error", v)
		}
	}
}

func TestValidateMarkerValue(t *testing.T) {
	// The empty string is valid — it means "unset" (no marker). The closed set
	// is the twelve `<mode>[:<stage>]` tokens (display order manual/auto/blocked
	// × bare/1/2/3).
	valid := []string{
		"",
		"manual", "manual:1", "manual:2", "manual:3",
		"auto", "auto:1", "auto:2", "auto:3",
		"blocked", "blocked:1", "blocked:2", "blocked:3",
	}
	for _, v := range valid {
		if msg := ValidateMarkerValue(v); msg != "" {
			t.Errorf("ValidateMarkerValue(%q) = %q, want valid", v, msg)
		}
	}
	// Anything outside the closed set is rejected (case-sensitive, no whitespace
	// tolerance — the frontend only ever writes the canonical tokens). The
	// Flat tokens and mode:stage near-misses all reject. The closed set
	// never falls back to pattern matching, and flair tokens are not markers.
	invalid := []string{
		"pipe", "dotted", "dashed", "solid", "double", "thick", "hatch", "block",
		"Dotted", "Dashed", "DASHED", "THICK", "Hatch", "dot", "dash", " solid ", " thick ",
		"4", "1+3", "none", "true", "rain", "scan", "nyan",
		"manual:0", "manual:4", "manual:", "manual:1:2", "MANUAL", " manual ", "auto:01", "mode:stage",
	}
	for _, v := range invalid {
		if msg := ValidateMarkerValue(v); msg == "" {
			t.Errorf("ValidateMarkerValue(%q) = valid, want error", v)
		}
	}
}

func TestValidateRoleValue(t *testing.T) {
	// The empty string is valid — it means "unset" (no role). The closed set is
	// the single "operator" role.
	valid := []string{"", "operator"}
	for _, v := range valid {
		if msg := ValidateRoleValue(v); msg != "" {
			t.Errorf("ValidateRoleValue(%q) = %q, want valid", v, msg)
		}
	}
	// Anything outside the closed set is rejected (case-sensitive, no whitespace
	// tolerance — writers only ever send the canonical token).
	invalid := []string{"Operator", "OPERATOR", " operator ", "op", "manager", "worker", "4", "none", "true"}
	for _, v := range invalid {
		if msg := ValidateRoleValue(v); msg == "" {
			t.Errorf("ValidateRoleValue(%q) = valid, want error", v)
		}
	}
}

func TestValidateFlairValue(t *testing.T) {
	// The empty string is valid — it means "unset" (no flair). The closed set
	// is the 16 named states (the frontend's FLAIR_STATES minus "").
	valid := []string{"", "rain", "scan", "nyan", "naruto", "onepiece", "pacman", "matrix", "aquarium", "nemo", "roadrunner", "invaders", "cube", "warp", "spidey", "ironman", "noon"}
	for _, v := range valid {
		if msg := ValidateFlairValue(v); msg != "" {
			t.Errorf("ValidateFlairValue(%q) = %q, want valid", v, msg)
		}
	}
	// Anything outside the closed set is rejected (case-sensitive, no whitespace
	// tolerance — the frontend only ever writes the canonical tokens). The
	// rejected-in-review train/dvd/tetris tokens stay OUT, and marker tokens
	// are NOT flairs — the axes are independent closed sets.
	invalid := []string{"Nyan", "NYAN", "Naruto", "ONEPIECE", "Nemo", "NEMO", "Spidey", "SPIDEY", "Ironman", "IRONMAN", "IronMan", "Noon", "NOON", " spidey ", " ironman ", " nyan ", " onepiece ", " noon ", "pikachu", "one-piece", "iron-man", "midday", "4", "1+3", "none", "true", "train", "dvd", "tetris", "hatch", "pipe", "block", "dashed"}
	for _, v := range invalid {
		if msg := ValidateFlairValue(v); msg == "" {
			t.Errorf("ValidateFlairValue(%q) = valid, want error", v)
		}
	}
}

func TestValidateOwnerValue(t *testing.T) {
	// The empty string is valid — it means "unset" (no owner). The closed set
	// is the single "operator" token.
	valid := []string{"", "operator"}
	for _, v := range valid {
		if msg := ValidateOwnerValue(v); msg != "" {
			t.Errorf("ValidateOwnerValue(%q) = %q, want valid", v, msg)
		}
	}
	// Anything outside the closed set is rejected (case-sensitive, no
	// whitespace tolerance); the message lists the accepted token.
	invalid := []string{"Operator", "OPERATOR", " operator ", "done", "op", "none", "true"}
	for _, v := range invalid {
		msg := ValidateOwnerValue(v)
		if msg == "" {
			t.Errorf("ValidateOwnerValue(%q) = valid, want error", v)
		} else if !strings.Contains(msg, "operator") {
			t.Errorf("ValidateOwnerValue(%q) = %q, want the closed set named", v, msg)
		}
	}
}

func TestValidateNoteText(t *testing.T) {
	// Trim: surrounding whitespace collapses and the trimmed form is returned.
	if trimmed, msg := ValidateNoteText("  tests green  "); msg != "" || trimmed != "tests green" {
		t.Errorf("ValidateNoteText(trim) = (%q, %q), want (\"tests green\", \"\")", trimmed, msg)
	}
	// Empty-after-trim is NOT an error here — callers decide what empty means.
	if trimmed, msg := ValidateNoteText("   "); msg != "" || trimmed != "" {
		t.Errorf("ValidateNoteText(blank) = (%q, %q), want (\"\", \"\")", trimmed, msg)
	}
	// Exactly at the bound is valid; one over is rejected with the bound named.
	max := strings.Repeat("a", NoteTextMaxLength)
	if _, msg := ValidateNoteText(max); msg != "" {
		t.Errorf("ValidateNoteText(120 chars) = %q, want valid", msg)
	}
	if _, msg := ValidateNoteText(max + "a"); msg != "note exceeds 120 characters" {
		t.Errorf("ValidateNoteText(121 chars) = %q, want the length message", msg)
	}
	// Control runes (tab/newline/NUL) are rejected even inside the length bound.
	for _, v := range []string{"a\tb", "a\nb", "a\x00b"} {
		if _, msg := ValidateNoteText(v); msg != "note cannot contain control characters" {
			t.Errorf("ValidateNoteText(%q) = %q, want the control-character message", v, msg)
		}
	}
}

func TestNormalizeColorValue(t *testing.T) {
	cases := map[string]struct {
		want string
		ok   bool
	}{
		"4":       {"4", true},
		" 4 ":     {"4", true},
		"1+3":     {"1+3", true},
		" 1 + 3 ": {"1+3", true}, // internal whitespace collapses to canonical form
		"01":      {"1", true},   // leading zeros re-serialized
		"0+15":    {"0+15", true},
		// Family-name vocabulary: canonical form is the trimmed verbatim name
		// (all three shades); near-misses are rejected like any malformed value.
		"blue":          {"blue", true},
		"blue-dark":     {"blue-dark", true},
		"blue-light":    {"blue-light", true},
		" slate-dark ":  {"slate-dark", true},
		" slate-light ": {"slate-light", true},
		"orange":        {"orange", true},
		"bluish":        {"", false},
		"bluish-light":  {"", false},
		"blue-lite":     {"", false},
		"Blue":          {"", false},
		"":             {"", false},
		"  ":           {"", false},
		"99":           {"", false},
		"1+2+3":        {"", false},
		"x":            {"", false},
	}
	for in, exp := range cases {
		got, ok := NormalizeColorValue(in)
		if got != exp.want || ok != exp.ok {
			t.Errorf("NormalizeColorValue(%q) = (%q, %v), want (%q, %v)", in, got, ok, exp.want, exp.ok)
		}
	}
}

// --- ValidateSSHHost / ValidateInstanceName (260723-o7q8) ---

func TestValidateSSHHost(t *testing.T) {
	valid := []string{"devbox", "user@host.example.com", "192.168.1.10", "my-alias_1"}
	for _, v := range valid {
		if msg := ValidateSSHHost(v); msg != "" {
			t.Errorf("ValidateSSHHost(%q) = %q, want valid", v, msg)
		}
	}

	invalid := []string{
		"dev box",    // space
		"dev\tbox",   // tab
		"dev\nbox",   // newline
		"dev\x07box", // control char
		strings.Repeat("a", MaxSettingValueLength+1), // over cap
	}
	for _, v := range invalid {
		if msg := ValidateSSHHost(v); msg == "" {
			t.Errorf("ValidateSSHHost(%q) accepted, want rejection", v)
		}
	}

	// Exactly at the cap is legal.
	if msg := ValidateSSHHost(strings.Repeat("a", MaxSettingValueLength)); msg != "" {
		t.Errorf("ValidateSSHHost(cap-length) = %q, want valid", msg)
	}
}

func TestValidateInstanceName(t *testing.T) {
	valid := []string{"my-box", "dev mini", "Mac Studio (office)"}
	for _, v := range valid {
		if msg := ValidateInstanceName(v); msg != "" {
			t.Errorf("ValidateInstanceName(%q) = %q, want valid", v, msg)
		}
	}

	invalid := []string{
		"my\nbox",    // newline
		"my\x07box",  // control char
		"my \"box\"", // double quote (quoted round-trip guard)
		strings.Repeat("a", MaxSettingValueLength+1), // over cap
	}
	for _, v := range invalid {
		if msg := ValidateInstanceName(v); msg == "" {
			t.Errorf("ValidateInstanceName(%q) accepted, want rejection", v)
		}
	}
}

func TestValidateRemoteName(t *testing.T) {
	tests := []struct {
		name     string
		input    string
		wantErr  bool
		contains string
	}{
		{"valid simple", "buildbox", false, ""},
		{"valid hyphenated", "build-box-2", false, ""},
		{"valid underscore", "build_box", false, ""},
		// Inherited from the shared ValidateNewName rule.
		{"empty rejected", "", true, "cannot be empty"},
		{"forbidden semicolon", "bad;name", true, "forbidden characters"},
		{"forbidden dollar", "bad$name", true, "forbidden characters"},
		{"contains period", "build.example.com", true, "colons or periods"},
		{"contains colon", "bad:name", true, "colons or periods"},
		{"space rejected", "bad name", true, "cannot contain spaces"},
		// Remote-seam hardening.
		{"leading hyphen rejected", "-buildbox", true, "must not start with a hyphen"},
		{"slash rejected", "a/b", true, "must not contain a slash"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := ValidateRemoteName(tt.input)
			if tt.wantErr && result == "" {
				t.Errorf("ValidateRemoteName(%q) = valid, want error", tt.input)
			}
			if !tt.wantErr && result != "" {
				t.Errorf("ValidateRemoteName(%q) = %q, want valid", tt.input, result)
			}
			if tt.contains != "" && result != "" && !contains(result, tt.contains) {
				t.Errorf("ValidateRemoteName(%q) = %q, want error containing %q", tt.input, result, tt.contains)
			}
		})
	}
}

func TestValidateRemoteTarget(t *testing.T) {
	valid := []string{"buildbox", "sahil@buildbox", "sahil@build.example.com", "root@10.0.0.7"}
	for _, v := range valid {
		if msg := ValidateRemoteTarget(v); msg != "" {
			t.Errorf("ValidateRemoteTarget(%q) = %q, want valid", v, msg)
		}
	}

	tests := []struct {
		name     string
		input    string
		contains string
	}{
		{"empty rejected", "", "cannot be empty"},
		{"whitespace-only rejected", "   ", "cannot be empty"},
		// Flag-injection defense: a leading '-' would read as an ssh option.
		{"leading hyphen rejected", "-oProxyCommand=evil", "must not start with a hyphen"},
		// Inherited ValidateSSHHost rules.
		{"inner space rejected", "user@host extra", "whitespace or control"},
		{"newline rejected", "host\nname", "whitespace or control"},
		{"double quote rejected", `host"name`, "double quotes"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := ValidateRemoteTarget(tt.input)
			if result == "" {
				t.Fatalf("ValidateRemoteTarget(%q) = valid, want error", tt.input)
			}
			if !contains(result, tt.contains) {
				t.Errorf("ValidateRemoteTarget(%q) = %q, want error containing %q", tt.input, result, tt.contains)
			}
		})
	}
}

func TestValidateGUIID(t *testing.T) {
	tests := []struct {
		name  string
		input string
		valid bool
	}{
		{"host", "host", true},
		{"case-sensitive", "Host", false},
		{"suffix rejected", "host2", false},
		{"empty rejected", "", false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := ValidateGUIID(tt.input)
			if tt.valid && got != "" {
				t.Errorf("ValidateGUIID(%q) = %q, want valid", tt.input, got)
			}
			if !tt.valid && got != `gui id must be "host"` {
				t.Errorf("ValidateGUIID(%q) = %q, want %q", tt.input, got, `gui id must be "host"`)
			}
		})
	}
}

func TestValidateWebTabURL(t *testing.T) {
	accepted := []string{
		"/",
		"/proxy/3000/",
		"/proxy/80/app",
		"/present/@320/2/file.html?server=runKit&v=1",
		"/present/@7/mock.html?server=dev&v=1",
		"/tutorial/ch1-orientation.html",
		"/app/index.html?q=1#section",
		"https://example.com",
		"https://example.com/path?q=1",
		"http://localhost:3000/x",
		"http://192.168.1.20:8080/lan",
	}
	for _, v := range accepted {
		if got := ValidateWebTabURL(v); got != "" {
			t.Errorf("accept %q: got %q, want valid", v, got)
		}
	}

	rejected := []string{
		"javascript:alert(1)",
		"data:text/html,<script>alert(1)</script>",
		"file:///etc/passwd",
		"//evil.com/x",
		"ftp://example.com/x",
		"example.com",
		"localhost:3000",
		"https://",
		`/\evil.com/x`,     // browser-normalized host escape
		`/\\evil.com/x`,    // scheme-relative after normalization
		" /proxy/3000/",    // leading whitespace
		"/tutorial/\npage", // control character
	}
	for _, v := range rejected {
		if got := ValidateWebTabURL(v); got == "" {
			t.Errorf("reject %q: got valid, want error", v)
		}
	}
}

func TestSessionNameFromPath(t *testing.T) {
	tests := []struct {
		name  string
		input string
		want  string
	}{
		{"plain folder", "~/code/hexokit", "hexokit"},
		{"dots and hyphens", "~/code/my-app.v2", "my_app_v2"},
		{"spaces", "~/code/my app", "my_app"},
		{"trailing slash", "~/code/hexokit/", "hexokit"},
		{"multiple trailing slashes", "/home/u/code/x//", "x"},
		{"home tilde", "~", ""},
		{"home tilde slash", "~/", ""},
		{"empty", "", ""},
		{"root", "/", ""},
		{"dotfile folder", "~/.config", "config"},
		{"only unsafe chars", "~/code/...", ""},
		{"runs collapse", "~/code/a--b__c", "a_b_c"},
		{"edges trimmed", "~/code/-x-", "x"},
		{"colon and metachar", "~/code/a:b;c", "a_b_c"},
		{"bare name", "hexokit", "hexokit"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := SessionNameFromPath(tt.input)
			if got != tt.want {
				t.Fatalf("SessionNameFromPath(%q) = %q, want %q", tt.input, got, tt.want)
			}
			if got != "" {
				if msg := ValidateNewName(got, "Session name"); msg != "" {
					t.Fatalf("derived %q fails ValidateNewName: %s", got, msg)
				}
			}
		})
	}
}

func TestSessionNameFromPathMaxLength(t *testing.T) {
	long := "~/code/" + strings.Repeat("a", 300)
	got := SessionNameFromPath(long)
	if len(got) != MaxNameLength {
		t.Fatalf("len = %d, want %d", len(got), MaxNameLength)
	}
	multi := "~/code/" + strings.Repeat("é", 100)
	got = SessionNameFromPath(multi)
	if len(got) > MaxNameLength || !utf8.ValidString(got) {
		t.Fatalf("multibyte cap broke: len=%d valid=%v", len(got), utf8.ValidString(got))
	}
	if msg := ValidateNewName(got, "Session name"); msg != "" {
		t.Fatalf("capped name fails ValidateNewName: %s", msg)
	}
}
