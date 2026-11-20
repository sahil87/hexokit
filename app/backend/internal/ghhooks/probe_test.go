package ghhooks

import (
	"context"
	"errors"
	"reflect"
	"testing"
)

func stubGH(t *testing.T, fn func(args ...string) ([]byte, error)) *[][]string {
	t.Helper()
	var calls [][]string
	orig := runGH
	runGH = func(_ context.Context, args ...string) ([]byte, error) {
		calls = append(calls, args)
		return fn(args...)
	}
	t.Cleanup(func() { runGH = orig })
	return &calls
}

func TestProbeAdmin(t *testing.T) {
	cases := []struct {
		name    string
		out     string
		err     error
		want    Admin
		wantErr bool
	}{
		{name: "admin", out: "true\n", want: AdminYes},
		{name: "no admin", out: "false\n", want: AdminNo},
		{name: "gh error", err: errors.New("gh api: HTTP 404"), want: AdminProbeFailed, wantErr: true},
		{name: "timeout", err: context.DeadlineExceeded, want: AdminProbeFailed, wantErr: true},
		{name: "null answer", out: "null\n", want: AdminProbeFailed, wantErr: true},
		{name: "empty answer", out: "", want: AdminProbeFailed, wantErr: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			calls := stubGH(t, func(...string) ([]byte, error) { return []byte(tc.out), tc.err })
			res := ProbeAdmin(context.Background(), "o/r")
			if res.Admin != tc.want || (res.Err != nil) != tc.wantErr {
				t.Errorf("ProbeAdmin = %+v, want admin=%v err=%v", res, tc.want, tc.wantErr)
			}
			if want := []string{"api", "repos/o/r", "--jq", ".permissions.admin"}; !reflect.DeepEqual((*calls)[0], want) {
				t.Errorf("argv = %v, want %v", (*calls)[0], want)
			}
		})
	}
}

func TestProbeAdminRejectsABadRepoWithoutRunningGH(t *testing.T) {
	calls := stubGH(t, func(...string) ([]byte, error) { return []byte("true"), nil })
	for _, nwo := range []string{"", "no-slash", "a/b; rm -rf", "../x/y", "o/r --flag"} {
		if res := ProbeAdmin(context.Background(), nwo); res.Admin != AdminProbeFailed || res.Err == nil {
			t.Errorf("ProbeAdmin(%q) = %+v, want a failed probe", nwo, res)
		}
	}
	if len(*calls) != 0 {
		t.Errorf("gh ran for an invalid repo: %v", *calls)
	}
}

func TestZeroAdminIsNeverAdmin(t *testing.T) {
	var res ProbeResult
	if res.Admin == AdminYes {
		t.Error("the zero ProbeResult must not read as admin")
	}
}

func TestExtensionInstalled(t *testing.T) {
	calls := stubGH(t, func(...string) ([]byte, error) { return nil, nil })
	if !ExtensionInstalled(context.Background()) {
		t.Error("a clean exit means installed")
	}
	if want := []string{"webhook", "forward", "--help"}; !reflect.DeepEqual((*calls)[0], want) {
		t.Errorf("argv = %v, want %v", (*calls)[0], want)
	}
	stubGH(t, func(...string) ([]byte, error) { return nil, errors.New(`unknown command "webhook"`) })
	if ExtensionInstalled(context.Background()) {
		t.Error("an error means not installed")
	}
}
