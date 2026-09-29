package main

import (
	"bytes"
	"testing"

	"rk/internal/portpolicy"
	"rk/internal/settings"
)

// runPorts drives `rk ports` through the real cobra Execute() seam (the
// url_test.go pattern): buffers on the shared rootCmd, root flag state reset,
// portsJSON cleared on cleanup so a --json run cannot bleed into a bare run.
func runPorts(t *testing.T, args ...string) (string, string) {
	t.Helper()
	resetRootFlagState(t)
	var stdout, stderr bytes.Buffer
	rootCmd.SetOut(&stdout)
	rootCmd.SetErr(&stderr)
	rootCmd.SetArgs(append([]string{"ports"}, args...))
	t.Cleanup(func() {
		rootCmd.SetOut(nil)
		rootCmd.SetErr(nil)
		rootCmd.SetArgs(nil)
		portsJSON = false
	})
	if err := rootCmd.Execute(); err != nil {
		t.Fatalf("ports Execute err = %v, want nil (exit 0, warn-only)", err)
	}
	return stdout.String(), stderr.String()
}

func TestPortsCommandRegistered(t *testing.T) {
	found := false
	for _, cmd := range rootCmd.Commands() {
		if cmd.Name() == "ports" {
			found = true
			break
		}
	}
	if !found {
		t.Error("expected 'ports' subcommand to be registered on rootCmd")
	}
}

// TestPortsJSONDefault pins the stable envelope shape with no env override:
// one {"ok":true,"result":…} document, effective port equal to the policy
// default, and collisions as an empty array (never null). The config root is
// isolated so the developer's real config.yaml (and its port key) and any
// legacy-home virtual pin cannot leak into the resolution.
func TestPortsJSONDefault(t *testing.T) {
	t.Setenv("RK_PORT", "")
	t.Setenv("RK_CODE_SERVER_PORT", "")
	t.Setenv(settings.ConfigDirEnv, t.TempDir())

	stdout, stderr := runPorts(t, "--json")

	want := map[string]any{
		"daemon": map[string]any{
			"default_port":               float64(portpolicy.DaemonDefault),
			"default_dev_backend_port":   float64(portpolicy.DaemonDefault + 1),
			"default_code_server_port":   float64(portpolicy.DaemonDefault + 2),
			"effective_port":             float64(portpolicy.DaemonDefault),
			"effective_code_server_port": float64(portpolicy.DaemonDefault + 2),
		},
		"blocks": []any{
			map[string]any{"name": "rig", "start": float64(21000), "end": float64(21299)},
			map[string]any{"name": "tunnel", "start": float64(3100), "end": float64(3199)},
		},
		"sentinel":   float64(21999),
		"collisions": []any{},
	}
	assertEnvelopeResult(t, stdout, want)
	if stderr != "" {
		t.Errorf("ports --json wrote to stderr: %q", stderr)
	}
}

// TestPortsCollisionHuman: RK_PORT=3150 lands in the tunnel block — the human
// output names the block and its range, still exit 0 (warn-only).
func TestPortsCollisionHuman(t *testing.T) {
	t.Setenv("RK_PORT", "3150")
	t.Setenv("RK_CODE_SERVER_PORT", "")

	stdout, _ := runPorts(t)

	for _, want := range []string{"WARNING", "tunnel", "3100", "3150"} {
		if !bytes.Contains([]byte(stdout), []byte(want)) {
			t.Errorf("human output missing %q; got:\n%s", want, stdout)
		}
	}
}

// TestPortsCollisionJSON: the same collision surfaces in the envelope's
// collisions list with the block's name/start/end.
func TestPortsCollisionJSON(t *testing.T) {
	t.Setenv("RK_PORT", "3150")
	t.Setenv("RK_CODE_SERVER_PORT", "")

	stdout, _ := runPorts(t, "--json")

	want := map[string]any{
		"daemon": map[string]any{
			"default_port":               float64(portpolicy.DaemonDefault),
			"default_dev_backend_port":   float64(portpolicy.DaemonDefault + 1),
			"default_code_server_port":   float64(portpolicy.DaemonDefault + 2),
			"effective_port":             float64(3150),
			"effective_code_server_port": float64(3152),
		},
		"blocks": []any{
			map[string]any{"name": "rig", "start": float64(21000), "end": float64(21299)},
			map[string]any{"name": "tunnel", "start": float64(3100), "end": float64(3199)},
		},
		"sentinel": float64(21999),
		"collisions": []any{
			map[string]any{"name": "tunnel", "start": float64(3100), "end": float64(3199)},
		},
	}
	assertEnvelopeResult(t, stdout, want)
}

// TestPortsHelpNamesPolicy pins the help contract: the Long text says this is
// the port policy, not a listing of live listening ports, and an Example is
// attached (layered help).
func TestPortsHelpNamesPolicy(t *testing.T) {
	for _, want := range []string{"policy", "not a listing of live listening ports", "Ports tile"} {
		if !bytes.Contains([]byte(portsCmd.Long), []byte(want)) {
			t.Errorf("ports Long text missing %q; got:\n%s", want, portsCmd.Long)
		}
	}
	if !bytes.Contains([]byte(portsCmd.Example), []byte("rk ports")) {
		t.Errorf("ports Example missing an invocation:\n%s", portsCmd.Example)
	}
}

// TestPortsRigBlockExemption: a dev build on a rig-block port reports no
// collision (dev/e2e rigs live there by design); a released build on the
// same port names the rig block. The version var is the ldflags seam.
func TestPortsRigBlockExemption(t *testing.T) {
	t.Setenv("RK_PORT", "21000")
	t.Setenv("RK_CODE_SERVER_PORT", "")

	stdout, _ := runPorts(t)
	if !bytes.Contains([]byte(stdout), []byte("Collisions: none")) {
		t.Errorf("dev build on a rig port must report no collision; got:\n%s", stdout)
	}

	orig := version
	version = "1.2.3"
	t.Cleanup(func() { version = orig })
	stdout, _ = runPorts(t)
	for _, want := range []string{"WARNING", "rig", "21000"} {
		if !bytes.Contains([]byte(stdout), []byte(want)) {
			t.Errorf("released build on a rig port missing %q; got:\n%s", want, stdout)
		}
	}
}
