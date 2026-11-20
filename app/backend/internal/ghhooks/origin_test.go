package ghhooks

import (
	"context"
	"errors"
	"testing"
)

func TestParseOriginURL(t *testing.T) {
	cases := []struct {
		in   string
		want string
		ok   bool
	}{
		{"https://github.com/sahil87/hexokit.git", "sahil87/hexokit", true},
		{"https://github.com/sahil87/hexokit", "sahil87/hexokit", true},
		{"https://github.com/sahil87/hexokit/", "sahil87/hexokit", true},
		{"https://user:token@github.com/o/r.git\n", "o/r", true},
		{"git@github.com:sahil87/hexokit.git", "sahil87/hexokit", true},
		{"ssh://git@github.com/o/r.git", "o/r", true},
		{"ssh://git@github.com:22/o/r", "o/r", true},
		{"https://ghe.example.com/team/proj.git", "team/proj", true},
		{"", "", false},
		{"/local/path/repo", "", false},
		{"https://github.com/onlyowner", "", false},
		{"git@github.com:onlyowner", "", false},
		{"https://github.com/bad owner/r", "", false},
	}
	for _, tc := range cases {
		got, ok := ParseOriginURL(tc.in)
		if ok != tc.ok || got != tc.want {
			t.Errorf("ParseOriginURL(%q) = %q, %v; want %q, %v", tc.in, got, ok, tc.want, tc.ok)
		}
	}
}

func TestGitOriginNWO(t *testing.T) {
	orig := gitOriginURL
	t.Cleanup(func() { gitOriginURL = orig })

	gitOriginURL = func(_ context.Context, dir string) (string, error) {
		if dir != "/code/r" {
			return "", errors.New("not a git checkout")
		}
		return "git@github.com:sahil87/hexokit.git\n", nil
	}
	if got, err := GitOriginNWO(context.Background(), "/code/r"); err != nil || got != "sahil87/hexokit" {
		t.Errorf("GitOriginNWO = %q, %v", got, err)
	}
	if _, err := GitOriginNWO(context.Background(), "/elsewhere"); err == nil {
		t.Error("a git failure must surface")
	}
	gitOriginURL = func(context.Context, string) (string, error) { return "/srv/git/local.git\n", nil }
	if _, err := GitOriginNWO(context.Background(), "/code/r"); err == nil {
		t.Error("a non-GitHub origin must be an error")
	}
}
