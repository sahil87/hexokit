package api

import (
	"reflect"
	"testing"

	"rk/internal/tmux"
)

func TestBlockTargetOrder(t *testing.T) {
	windows := []tmux.WindowInfo{
		sortWin(0, "@1"),
		sortWin(1, "@2"),
		sortWin(2, "@3"),
		sortWin(3, "@4"),
		sortWin(4, "@5"),
	}

	tests := []struct {
		name    string
		members []string
		before  string
		want    []string
	}{
		{
			name:    "forward block",
			members: []string{"@1", "@2"},
			before:  "@5",
			want:    []string{"@3", "@4", "@1", "@2", "@5"},
		},
		{
			name:    "backward block",
			members: []string{"@2", "@4"},
			before:  "@1",
			want:    []string{"@2", "@4", "@1", "@3", "@5"},
		},
		{
			name:    "scattered members retain payload order",
			members: []string{"@4", "@2"},
			before:  "@3",
			want:    []string{"@1", "@4", "@2", "@3", "@5"},
		},
		{
			name:    "single member",
			members: []string{"@4"},
			before:  "@2",
			want:    []string{"@1", "@4", "@2", "@3", "@5"},
		},
		{
			name:    "already in place",
			members: []string{"@1"},
			before:  "@2",
			want:    []string{"@1", "@2", "@3", "@4", "@5"},
		},
		{
			name:    "already in place multiple members",
			members: []string{"@2", "@3"},
			before:  "@4",
			want:    []string{"@1", "@2", "@3", "@4", "@5"},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			target := blockTargetOrder(windows, tt.members, tt.before)
			if got := windowIDs(target); !reflect.DeepEqual(got, tt.want) {
				t.Fatalf("blockTargetOrder() = %v, want %v", got, tt.want)
			}
			if tt.name == "already in place" || tt.name == "already in place multiple members" {
				if moves := planSortMoves(windows, target); len(moves) != 0 {
					t.Fatalf("planSortMoves() = %v, want no moves", moves)
				}
			}
		})
	}

	if got := windowIDs(windows); !reflect.DeepEqual(got, []string{"@1", "@2", "@3", "@4", "@5"}) {
		t.Fatalf("blockTargetOrder mutated input: %v", got)
	}
}
