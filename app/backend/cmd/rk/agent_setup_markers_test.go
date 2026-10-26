package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// registryEntry returns the named provider's registry row under an isolated
// home. The CODEX_HOME/COPILOT_HOME/KIMI_CODE_HOME overrides are CLEARED so
// paths derive from home — tests exercising an override set it AFTER this
// call and re-run agentRegistry themselves (see TestCodexHomeEnvOverride).
func registryEntry(t *testing.T, home, provider string) agentConfig {
	t.Helper()
	for _, env := range []string{"CODEX_HOME", "COPILOT_HOME", "KIMI_CODE_HOME"} {
		t.Setenv(env, "")
	}
	for _, ac := range agentRegistry(home) {
		if ac.provider == provider {
			return ac
		}
	}
	t.Fatalf("provider %q not in the registry", provider)
	return agentConfig{}
}

// applyYes runs applyAgentConfig with --yes consent against a capture buffer.
func applyYes(t *testing.T, ac agentConfig, rkPath string, uninstall bool) *bytes.Buffer {
	t.Helper()
	var out bytes.Buffer
	launcher := ""
	if !uninstall {
		launcher = testLauncherPath
	}
	if err := applyAgentConfig(newSinkWriters(&out, &out), bufio.NewReader(strings.NewReader("")), ac, launcher, rkPath, uninstall, consent{yes: true}); err != nil {
		t.Fatalf("applyAgentConfig(%s, uninstall=%v) error: %v", ac.provider, uninstall, err)
	}
	return &out
}

// --- codex / gemini (kindJSONHooksMerge) --------------------------------------

func TestCodexInstallMergeAndTrustNote(t *testing.T) {
	home := t.TempDir()
	ac := registryEntry(t, home, "codex")
	// The codex hooks target is hooks.json under the codex home, NOT a
	// Claude-shaped settings.json.
	if filepath.Base(ac.settingsPath) != "hooks.json" {
		t.Errorf("codex target = %s, want hooks.json", ac.settingsPath)
	}

	out := applyYes(t, ac, "/opt/homebrew/bin/rk", false)
	settings, err := readSettings(ac.settingsPath)
	if err != nil {
		t.Fatal(err)
	}
	if got := countRkEntries(settings); got != len(ac.hooks) {
		t.Errorf("rk entries = %d, want %d", got, len(ac.hooks))
	}
	// Every installed command targets --agent codex and the shared events exist.
	raw := mustMarshalIndent(settings)
	if !strings.Contains(raw, "--agent codex") {
		t.Errorf("codex entries must invoke --agent codex:\n%s", raw)
	}
	for _, event := range []string{"UserPromptSubmit", "PreToolUse", "PermissionRequest", "PostToolUse", "Interrupt", "Stop", "SessionEnd", "SessionStart"} {
		if asMap(settings["hooks"])[event] == nil {
			t.Errorf("codex mapping missing event %s", event)
		}
	}
	// Codex's native trust requirement is surfaced, never glossed over.
	if !strings.Contains(out.String(), "/hooks") {
		t.Errorf("install output must name the /hooks trust step, got: %s", out.String())
	}

	// A foreign entry survives a re-merge and the re-run is idempotent.
	settings["other"] = "user-value"
	if err := writeSettings(ac.settingsPath, settings); err != nil {
		t.Fatal(err)
	}
	out.Reset()
	applyYes(t, ac, "/opt/homebrew/bin/rk", false)
	settings, _ = readSettings(ac.settingsPath)
	if settings["other"] != "user-value" {
		t.Error("foreign config key lost on re-run")
	}
	if got := countRkEntries(settings); got != len(ac.hooks) {
		t.Errorf("rk entries after re-run = %d, want %d (no duplicates)", got, len(ac.hooks))
	}

	// Uninstall removes exactly the rk entries and leaves the foreign key.
	applyYes(t, ac, "", true)
	settings, _ = readSettings(ac.settingsPath)
	if got := countRkEntries(settings); got != 0 {
		t.Errorf("uninstall left %d rk entries", got)
	}
	if settings["other"] != "user-value" {
		t.Error("uninstall dropped the foreign key")
	}
}

func TestCodexHomeEnvOverride(t *testing.T) {
	home := t.TempDir()
	codexHome := t.TempDir()
	registryEntry(t, home, "codex") // registers the env cleanup
	t.Setenv("CODEX_HOME", codexHome)
	for _, ac := range agentRegistry(home) {
		if ac.provider == "codex" && filepath.Dir(ac.settingsPath) != codexHome {
			t.Errorf("codex settingsPath = %s, want under CODEX_HOME %s", ac.settingsPath, codexHome)
		}
	}
}

func TestGeminiInstallMerge(t *testing.T) {
	home := t.TempDir()
	ac := registryEntry(t, home, "gemini")
	// Pre-existing foreign config survives.
	if err := writeSettings(ac.settingsPath, map[string]any{"security": map[string]any{"auth": "x"}}); err != nil {
		t.Fatal(err)
	}
	applyYes(t, ac, "/opt/homebrew/bin/rk", false)
	settings, _ := readSettings(ac.settingsPath)
	if asMap(settings["security"]) == nil {
		t.Error("gemini merge dropped the foreign security key")
	}
	hooksRoot := asMap(settings["hooks"])
	for _, event := range []string{"BeforeAgent", "BeforeTool", "Notification", "AfterAgent", "SessionEnd", "SessionStart"} {
		if hooksRoot[event] == nil {
			t.Errorf("gemini mapping missing event %s", event)
		}
	}
	// The ToolPermission matcher rides the Notification entry.
	notif := asSlice(hooksRoot["Notification"])
	if len(notif) == 0 || asMap(notif[0])["matcher"] != "ToolPermission" {
		t.Errorf("gemini Notification entry = %v, want matcher ToolPermission", notif)
	}
	if !strings.Contains(mustMarshalIndent(settings), "--agent gemini") {
		t.Error("gemini entries must invoke --agent gemini")
	}
}

// --- copilot (kindMarkerFile, JSON) -------------------------------------------

func TestCopilotMarkerFileLifecycle(t *testing.T) {
	home := t.TempDir()
	ac := registryEntry(t, home, "copilot")
	if filepath.Base(ac.filePath) != "run-kit.json" {
		t.Errorf("copilot target = %s, want run-kit.json", ac.filePath)
	}

	out := applyYes(t, ac, "/opt/homebrew/bin/rk", false)
	data, err := os.ReadFile(ac.filePath)
	if err != nil {
		t.Fatalf("copilot hooks file should exist: %v", err)
	}
	var doc map[string]any
	if err := json.Unmarshal(data, &doc); err != nil {
		t.Fatalf("copilot file is not JSON: %v", err)
	}
	if doc["version"].(float64) != 1 {
		t.Errorf("version = %v, want 1", doc["version"])
	}
	hooks := asMap(doc["hooks"])
	for _, event := range []string{"sessionStart", "userPromptSubmitted", "preToolUse", "permissionRequest", "notification", "agentStop"} {
		if hooks[event] == nil {
			t.Errorf("copilot mapping missing event %s", event)
		}
	}
	// Flat entries: matcher rides the entry, NOT a nested hooks[] group.
	notif := asSlice(hooks["notification"])
	if len(notif) != 2 {
		t.Fatalf("copilot notification entries = %d, want 2 (waiting + idle)", len(notif))
	}
	for _, e := range notif {
		entry := asMap(e)
		if entry["matcher"] == nil || entry["command"] == nil {
			t.Errorf("copilot entry = %v, want flat matcher+command", entry)
		}
	}
	if !strings.Contains(string(data), "--agent copilot") {
		t.Error("copilot entries must invoke --agent copilot")
	}
	// Restart-to-load note printed.
	if !strings.Contains(out.String(), "restart") {
		t.Errorf("install output must note the restart-to-load requirement, got: %s", out.String())
	}
	// Mode 0600 (agent config sensitivity).
	if info, _ := os.Stat(ac.filePath); info.Mode().Perm() != 0o600 {
		t.Errorf("mode = %o, want 600", info.Mode().Perm())
	}

	// Re-run is a no-op.
	out = applyYes(t, ac, "/opt/homebrew/bin/rk", false)
	if !strings.Contains(out.String(), "nothing to do") {
		t.Errorf("re-install should be a no-op, got: %s", out.String())
	}

	// Uninstall removes exactly the file.
	applyYes(t, ac, "", true)
	if _, err := os.Stat(ac.filePath); !os.IsNotExist(err) {
		t.Errorf("uninstall should remove %s", ac.filePath)
	}
}

func TestCopilotForeignFileNeverTouched(t *testing.T) {
	home := t.TempDir()
	ac := registryEntry(t, home, "copilot")
	if err := os.MkdirAll(filepath.Dir(ac.filePath), 0o755); err != nil {
		t.Fatal(err)
	}
	foreign := []byte(`{"version": 1, "hooks": {"preToolUse": [{"type": "command", "command": "./mine.sh"}]}}`)
	if err := os.WriteFile(ac.filePath, foreign, 0o600); err != nil {
		t.Fatal(err)
	}

	out := applyYes(t, ac, "/opt/homebrew/bin/rk", false)
	got, _ := os.ReadFile(ac.filePath)
	if !bytes.Equal(got, foreign) {
		t.Error("a marker-less foreign run-kit.json must never be overwritten")
	}
	if !strings.Contains(out.String(), "leaving it untouched") {
		t.Errorf("the skip must be narrated, got: %s", out.String())
	}

	// Uninstall also refuses a foreign file.
	applyYes(t, ac, "", true)
	if _, err := os.Stat(ac.filePath); err != nil {
		t.Error("uninstall must not remove a foreign file")
	}
}

// --- kimi (kindMarkerBlock, TOML) ---------------------------------------------

func TestKimiMarkerBlockLifecycle(t *testing.T) {
	home := t.TempDir()
	ac := registryEntry(t, home, "kimi")
	userContent := "model = \"k2\"\n\n[features]\nfoo = true\n"
	if err := os.MkdirAll(filepath.Dir(ac.blockPath), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(ac.blockPath, []byte(userContent), 0o600); err != nil {
		t.Fatal(err)
	}

	applyYes(t, ac, "/opt/homebrew/bin/rk", false)
	data, err := os.ReadFile(ac.blockPath)
	if err != nil {
		t.Fatal(err)
	}
	content := string(data)
	if !strings.HasPrefix(content, userContent) {
		t.Errorf("user content must be preserved byte-exactly ahead of the block:\n%s", content)
	}
	if !strings.Contains(content, kimiHooksBlockBegin) || !strings.Contains(content, kimiHooksBlockEnd) {
		t.Error("marker block missing")
	}
	if strings.Count(content, "[[hooks]]") != len(kimiHooks) {
		t.Errorf("block should carry %d [[hooks]] tables, got:\n%s", len(kimiHooks), content)
	}
	for _, event := range []string{"SessionStart", "TurnStarted", "PreToolUse", "PermissionRequest", "Stop"} {
		if !strings.Contains(content, `event = "`+event+`"`) {
			t.Errorf("kimi mapping missing event %s", event)
		}
	}
	if !strings.Contains(content, "--agent kimi") {
		t.Error("kimi entries must invoke --agent kimi")
	}
	// The embedded command's double quotes are TOML-escaped.
	if !strings.Contains(content, `\"/opt/homebrew/bin/rk\"`) {
		t.Errorf("the rk path must be TOML-escaped, got:\n%s", content)
	}

	// Re-run is a no-op.
	var out bytes.Buffer
	if err := applyAgentConfig(newSinkWriters(&out, &out), bufio.NewReader(strings.NewReader("")), ac, testLauncherPath, "/opt/homebrew/bin/rk", false, consent{yes: true}); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "nothing to do") {
		t.Errorf("re-run should be a no-op, got: %s", out.String())
	}

	// Uninstall restores the original bytes exactly.
	applyYes(t, ac, "", true)
	restored, _ := os.ReadFile(ac.blockPath)
	if string(restored) != userContent {
		t.Errorf("uninstall must restore the original bytes, got:\n%s", restored)
	}
}

func TestKimiMalformedBlockRefused(t *testing.T) {
	home := t.TempDir()
	ac := registryEntry(t, home, "kimi")
	// A begin marker with no end marker: rk refuses to guess the region.
	content := "model = \"k2\"\n" + kimiHooksBlockBegin + "\nuser stuff below\n"
	if err := os.MkdirAll(filepath.Dir(ac.blockPath), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(ac.blockPath, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	out := applyYes(t, ac, "/opt/homebrew/bin/rk", false)
	got, _ := os.ReadFile(ac.blockPath)
	if string(got) != content {
		t.Error("a malformed block must refuse modification")
	}
	if !strings.Contains(out.String(), "leaving the file untouched") {
		t.Errorf("the refusal must be narrated, got: %s", out.String())
	}
}

// --- opencode (kindMarkerFile, JS plugin) --------------------------------------

func TestOpencodePluginLifecycle(t *testing.T) {
	home := t.TempDir()
	ac := registryEntry(t, home, "opencode")

	applyYes(t, ac, "/opt/homebrew/bin/rk", false)
	data, err := os.ReadFile(ac.filePath)
	if err != nil {
		t.Fatalf("opencode plugin should exist: %v", err)
	}
	content := string(data)
	if !strings.Contains(content, skillManagedByMarker) {
		t.Error("plugin must carry the managed-by marker")
	}
	if !strings.Contains(content, `const RK = "`+testLauncherPath+`";`) {
		t.Error("plugin must embed the launcher path in RK")
	}
	if !strings.Contains(content, `const RK_FALLBACK = "/opt/homebrew/bin/rk";`) {
		t.Error("plugin must embed the validated absolute rk path in RK_FALLBACK")
	}
	if !strings.Contains(content, `"--agent", "opencode"`) {
		t.Error("plugin must invoke --agent opencode")
	}
	for _, ev := range []string{"session.created", "session.idle", "permission.updated", "session.status", "parentID"} {
		if !strings.Contains(content, ev) {
			t.Errorf("plugin mapping missing %s", ev)
		}
	}
	// tool.execute.before is NOT an event-stream event in 1.18.25 — it must
	// not be mapped.
	if strings.Contains(content, "tool.execute.before") {
		t.Error("plugin must not map tool.execute.before (not an event-stream event)")
	}
	if !strings.Contains(content, "TMUX_PANE") {
		t.Error("plugin must no-op outside tmux")
	}

	// Uninstall removes the owned file; absent is then silent.
	applyYes(t, ac, "", true)
	if _, err := os.Stat(ac.filePath); !os.IsNotExist(err) {
		t.Error("uninstall should remove the plugin file")
	}
	out := applyYes(t, ac, "", true)
	if out.Len() != 0 {
		t.Errorf("uninstall of an absent plugin must be silent, got: %s", out.String())
	}
}

// --- cross-harness invariants --------------------------------------------------

// TestNoSubagentEventsRegistered pins the root-pane identity rule: no adapter
// may map a child/subagent harness event, or a subagent could replace the root
// pane's identity or falsely complete its turn.
func TestNoSubagentEventsRegistered(t *testing.T) {
	home := t.TempDir()
	for _, ac := range agentRegistry(home) {
		for _, h := range ac.hooks {
			if strings.Contains(strings.ToLower(h.event), "subagent") {
				t.Errorf("%s registers subagent event %q — child events must never write the root pane", ac.provider, h.event)
			}
		}
		if ac.fileContent != nil && strings.Contains(ac.fileContent(testLauncherPath, "/opt/homebrew/bin/rk"), `"subagent`) {
			t.Errorf("%s plugin/file content registers subagent events", ac.provider)
		}
	}
	// The opencode plugin has no hooks table — check its content for subagent
	// EVENT registrations (the word "subagent" in prose is fine; a mapped
	// event name is not).
	plugin := opencodePluginFile(testLauncherPath, "/opt/homebrew/bin/rk")
	if strings.Contains(plugin, `"subagent`) || strings.Contains(plugin, "SubagentStart") || strings.Contains(plugin, "SubagentStop") {
		t.Error("the opencode plugin must not map subagent events")
	}
}

// TestAgentSetupLongListsEveryProvider keeps the setup help text honest about
// the supported harness set.
func TestAgentSetupLongListsEveryProvider(t *testing.T) {
	for _, p := range []string{"Claude", "Codex", "Gemini", "Copilot", "Kimi", "OpenCode", "Antigravity"} {
		if !strings.Contains(agentSetupLong, p) {
			t.Errorf("setup Long help must name %s", p)
		}
	}
	if strings.Contains(agentSetupLong, "v1 targets") {
		t.Error("setup Long help must drop the Claude-only v1 wording")
	}
}

// TestAgentSetupPATHGate: installs skip harnesses whose binary is not on PATH;
// uninstalls are never gated (removal must work after the harness is gone).
func TestAgentSetupPATHGate(t *testing.T) {
	orig := agentBinaryOnPathFn
	agentBinaryOnPathFn = func(bin string) bool { return bin == "claude" }
	t.Cleanup(func() { agentBinaryOnPathFn = orig })

	home := t.TempDir()
	t.Setenv("CODEX_HOME", "")
	t.Setenv("COPILOT_HOME", "")
	t.Setenv("KIMI_CODE_HOME", "")
	t.Setenv("HOME", home)

	var out bytes.Buffer
	sink := newSinkWriters(&out, &out)
	if err := runAgentSetup(sink, strings.NewReader(""), false, consent{dryRun: true}); err != nil {
		t.Fatalf("runAgentSetup: %v", err)
	}
	// Codex (not on PATH per the stub) is skipped with a note; claude runs.
	if !strings.Contains(out.String(), "Codex: skipped") {
		t.Errorf("codex should be skipped off-PATH, got: %s", out.String())
	}
	if !strings.Contains(out.String(), "Claude Code") || strings.Contains(out.String(), "Claude Code: skipped") {
		t.Errorf("claude should NOT be skipped, got: %s", out.String())
	}
}

// --- agy (kindJSONHooksMerge, named-hooks document) ---------------------------

func TestAgyNamedHookLifecycle(t *testing.T) {
	home := t.TempDir()
	ac := registryEntry(t, home, "agy")
	if filepath.Base(ac.settingsPath) != "hooks.json" || !ac.namedHooksDoc {
		t.Fatalf("agy target = %s (namedHooksDoc=%v), want ~/.gemini/config/hooks.json named doc", ac.settingsPath, ac.namedHooksDoc)
	}

	// A foreign named hook survives install, re-run, and uninstall.
	foreign := map[string]any{
		"lint-checker": map[string]any{
			"PostToolUse": []any{map[string]any{"matcher": "run_command", "hooks": []any{map[string]any{"type": "command", "command": "./lint.sh"}}}},
		},
	}
	if err := writeSettings(ac.settingsPath, foreign); err != nil {
		t.Fatal(err)
	}

	out := applyYes(t, ac, "/opt/homebrew/bin/rk", false)
	settings, _ := readSettings(ac.settingsPath)
	if settings["lint-checker"] == nil {
		t.Error("foreign named hook dropped on install")
	}
	rkEntry := asMap(settings[rkNamedHookKey])
	if rkEntry == nil {
		t.Fatal("run-kit named hook missing after install")
	}
	if asSlice(rkEntry["PreInvocation"]) == nil || asSlice(rkEntry["Stop"]) == nil {
		t.Errorf("run-kit entry must carry flat PreInvocation + Stop handlers: %v", rkEntry)
	}
	raw := mustMarshalIndent(settings)
	if !strings.Contains(raw, `--agent agy`) || !strings.Contains(raw, `echo \"{}\"`) {
		t.Errorf("agy handlers must invoke --agent agy via the JSON-output wrapper:\n%s", raw)
	}
	// Tool-permission events are NEVER hooked (their contract answers
	// allow/deny decisions).
	if rkEntry["PreToolUse"] != nil || rkEntry["PostToolUse"] != nil {
		t.Error("agy entry must not hook tool events")
	}
	if !strings.Contains(out.String(), "waiting") {
		t.Errorf("install note must document the absent waiting signal, got: %s", out.String())
	}

	// Re-run is a no-op.
	out = applyYes(t, ac, "/opt/homebrew/bin/rk", false)
	if !strings.Contains(out.String(), "nothing to do") {
		t.Errorf("re-run should be a no-op, got: %s", out.String())
	}

	// Uninstall removes exactly the run-kit key.
	applyYes(t, ac, "", true)
	settings, _ = readSettings(ac.settingsPath)
	if settings[rkNamedHookKey] != nil {
		t.Error("uninstall must remove the run-kit named hook")
	}
	if settings["lint-checker"] == nil {
		t.Error("uninstall dropped the foreign named hook")
	}
}

// TestCopilotMixedFileSurvivesInstallAndUninstall (A-034): a user-owned
// run-kit.json carrying the user's OWN entries plus one rk-marked command is
// not wholly rk-owned — BOTH install and uninstall must leave it byte-exact
// untouched (the user's hooks are never overwritten or deleted).
func TestCopilotMixedFileSurvivesInstallAndUninstall(t *testing.T) {
	home := t.TempDir()
	ac := registryEntry(t, home, "copilot")
	if err := os.MkdirAll(filepath.Dir(ac.filePath), 0o755); err != nil {
		t.Fatal(err)
	}
	mixed := []byte(`{
  "version": 1,
  "hooks": {
    "preToolUse": [
      {"type": "command", "command": "./my-guard.sh"},
      {"type": "command", "command": "/bin/sh -c '[ -n \"$TMUX_PANE\" ] || exit 0; \"/home/u/.local/share/rk/bin/run-kit\" agent hook --agent copilot active 2>/dev/null || \"/opt/homebrew/bin/rk\" agent hook --agent copilot active 2>/dev/null || true'"}
    ]
  }
}`)
	if err := os.WriteFile(ac.filePath, mixed, 0o600); err != nil {
		t.Fatal(err)
	}

	out := applyYes(t, ac, "/opt/homebrew/bin/rk", false)
	if got, _ := os.ReadFile(ac.filePath); !bytes.Equal(got, mixed) {
		t.Errorf("install modified a mixed user file:\n%s", got)
	}
	if !strings.Contains(out.String(), "leaving it untouched") {
		t.Errorf("the mixed-file skip must be narrated, got: %s", out.String())
	}

	applyYes(t, ac, "", true)
	if got, _ := os.ReadFile(ac.filePath); !bytes.Equal(got, mixed) {
		t.Errorf("uninstall modified a mixed user file:\n%s", got)
	}
	if _, err := os.Stat(ac.filePath); err != nil {
		t.Error("uninstall deleted a mixed user file")
	}
}

// TestKimiDryRunNeverPrintsUserSecrets: the block preview renders only the
// managed region — a config.toml carrying credentials must not leak them into
// dry-run output.
func TestKimiDryRunNeverPrintsUserSecrets(t *testing.T) {
	home := t.TempDir()
	ac := registryEntry(t, home, "kimi")
	const sentinel = "sk-sentinel-secret-7f3a9c"
	content := "api_key = \"" + sentinel + "\"\nmodel = \"k2\"\n"
	if err := os.MkdirAll(filepath.Dir(ac.blockPath), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(ac.blockPath, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}

	var out bytes.Buffer
	if err := applyAgentConfig(newSinkWriters(&out, &out), bufio.NewReader(strings.NewReader("")), ac, testLauncherPath, "/opt/homebrew/bin/rk", false, consent{dryRun: true}); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(out.String(), sentinel) {
		t.Errorf("dry-run preview leaked user config:\n%s", out.String())
	}
	if !strings.Contains(out.String(), kimiHooksBlockBegin) {
		t.Errorf("dry-run preview must show the managed block, got:\n%s", out.String())
	}
	// Nothing written on dry-run.
	got, _ := os.ReadFile(ac.blockPath)
	if string(got) != content {
		t.Error("dry-run must not modify the file")
	}
}
