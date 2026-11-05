package openaimcp

import "testing"

func TestValidateTunnelID(t *testing.T) {
	valid := []string{
		"tunnel_0123456789abcdef0123456789abcdef",
		"tunnel_A1",
	}
	for _, id := range valid {
		if msg := ValidateTunnelID(id); msg != "" {
			t.Errorf("ValidateTunnelID(%q) = %q, want valid", id, msg)
		}
	}
	invalid := []string{
		"",
		"tunnel_",
		"6aec30eafeb08191ae53c6ec30819509",
		"Tunnel_abc",
		"tunnel_abc def",
		"tunnel_abc;rm",
		"tunnel_abc\n",
		"tunnel_ab-c",
	}
	for _, id := range invalid {
		if msg := ValidateTunnelID(id); msg == "" {
			t.Errorf("ValidateTunnelID(%q) = valid, want an error message", id)
		}
	}
}
