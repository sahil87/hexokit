package portpolicy

import "testing"

func TestCommittedValues(t *testing.T) {
	if DaemonDefault != 6123 {
		t.Errorf("DaemonDefault = %d, want 6123", DaemonDefault)
	}
	if DaemonLegacy != 3000 {
		t.Errorf("DaemonLegacy = %d, want 3000", DaemonLegacy)
	}
	if DaemonDefault == DaemonLegacy {
		t.Errorf("DaemonDefault and DaemonLegacy both %d — pin mechanism requires distinct values", DaemonDefault)
	}
	if Rig != (Block{Name: "rig", Start: 21000, End: 21299}) {
		t.Errorf("Rig = %+v, want {rig 21000 21299}", Rig)
	}
	if Tunnel != (Block{Name: "tunnel", Start: 3100, End: 3199}) {
		t.Errorf("Tunnel = %+v, want {tunnel 3100 3199}", Tunnel)
	}
	if Sentinel != 21999 {
		t.Errorf("Sentinel = %d, want 21999", Sentinel)
	}
}

func TestRigBlockInvariant(t *testing.T) {
	if n := Rig.End - Rig.Start + 1; n%3 != 0 {
		t.Errorf("rig block size %d not divisible by 3", n)
	} else if triples := n / 3; triples != 100 {
		t.Errorf("rig triples = %d, want 100", triples)
	}
	if Rig.Contains(Sentinel) {
		t.Errorf("sentinel %d lies inside rig block", Sentinel)
	}
	if Rig.Contains(DaemonDefault) {
		t.Errorf("daemon default %d lies inside rig block", DaemonDefault)
	}
	if Tunnel.Start <= Rig.End && Rig.Start <= Tunnel.End {
		t.Errorf("tunnel %d-%d overlaps rig %d-%d", Tunnel.Start, Tunnel.End, Rig.Start, Rig.End)
	}
}

func TestParseErrors(t *testing.T) {
	cases := map[string]string{
		"missing key":   "PORTPOLICY_DAEMON_DEFAULT=3000\n",
		"non-integer":   "PORTPOLICY_DAEMON_DEFAULT=abc\nPORTPOLICY_RIG_START=21000\nPORTPOLICY_RIG_END=21299\nPORTPOLICY_TUNNEL_START=3100\nPORTPOLICY_TUNNEL_END=3199\nPORTPOLICY_SENTINEL=21999\n",
		"not KEY=VALUE": "PORTPOLICY_DAEMON_DEFAULT 3000\n",
	}
	for name, data := range cases {
		if _, err := parse(data); err == nil {
			t.Errorf("%s: parse succeeded, want error", name)
		}
	}
}

func TestCollisions(t *testing.T) {
	cases := []struct {
		name                 string
		port, codeServerPort int
		want                 []string
	}{
		{"default no hit", 3000, 3002, nil},
		{"zero code-server ignored", 3000, 0, nil},
		{"+2 straddles into tunnel", 3098, 3100, []string{"tunnel"}},
		{"tunnel start", 3100, 3102, []string{"tunnel"}},
		{"tunnel end", 3199, 3201, []string{"tunnel"}},
		{"rig start", 21000, 21002, []string{"rig"}},
		{"rig end", 21299, 21301, []string{"rig"}},
		{"sentinel", 21999, 22001, []string{"sentinel"}},
		{"sentinel via code-server", 21997, 21999, []string{"sentinel"}},
		{"no double report", 21000, 21001, []string{"rig"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			hits := Collisions(tc.port, tc.codeServerPort)
			if len(hits) != len(tc.want) {
				t.Fatalf("Collisions(%d, %d) = %+v, want %d blocks", tc.port, tc.codeServerPort, hits, len(tc.want))
			}
			for i, name := range tc.want {
				if hits[i].Name != name {
					t.Errorf("hit %d = %q, want %q", i, hits[i].Name, name)
				}
			}
		})
	}
}

func TestReserved(t *testing.T) {
	res := Reserved()
	if len(res) != 3 {
		t.Fatalf("Reserved() returned %d blocks, want 3", len(res))
	}
	sentinel := res[2]
	if sentinel.Start != Sentinel || sentinel.End != Sentinel {
		t.Errorf("sentinel block = %+v, want one-port block at %d", sentinel, Sentinel)
	}
}

func TestSummary(t *testing.T) {
	want := "rig 21000–21299, tunnel 3100–3199, sentinel 21999"
	if got := Summary(); got != want {
		t.Errorf("Summary() = %q, want %q", got, want)
	}
}

func TestBlockString(t *testing.T) {
	cases := []struct {
		b    Block
		want string
	}{
		{Block{Name: "rig", Start: 21000, End: 21299}, "rig 21000–21299"},
		{Block{Name: "sentinel", Start: 21999, End: 21999}, "sentinel 21999"},
	}
	for _, c := range cases {
		if got := c.b.String(); got != c.want {
			t.Errorf("%+v.String() = %q, want %q", c.b, got, c.want)
		}
	}
}
