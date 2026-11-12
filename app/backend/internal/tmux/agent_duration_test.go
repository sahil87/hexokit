package tmux

import "testing"

func TestFormatAgentDuration(t *testing.T) {
	cases := []struct {
		elapsed int64
		want    string
	}{
		{-5, ""},
		{0, ""},
		{45, "45s"},
		{59, "59s"},
		{60, "1m"},
		{130, "2m"},
		{3599, "59m"},
		{3600, "1h"},
		{7300, "2h"},
	}
	for _, c := range cases {
		if got := FormatAgentDuration(c.elapsed); got != c.want {
			t.Errorf("FormatAgentDuration(%d) = %q, want %q", c.elapsed, got, c.want)
		}
	}
}
