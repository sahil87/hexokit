package main

import (
	"bufio"
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Every operator-skill test runs against a t.TempDir() home; the claude gate
// is stubbed through agentBinaryOnPathFn so the host PATH never decides.

// stubClaudeOnPath makes the claude binary resolve (or not) for one test.
func stubClaudeOnPath(t *testing.T, present bool) {
	t.Helper()
	orig := agentBinaryOnPathFn
	agentBinaryOnPathFn = func(bin string) bool { return present && bin == "claude" }
	t.Cleanup(func() { agentBinaryOnPathFn = orig })
}

// runOperatorSkill runs one applyOperatorSkill pass and returns its output.
func runOperatorSkill(t *testing.T, home string, uninstall bool, cons consent) (string, error) {
	t.Helper()
	var out bytes.Buffer
	err := applyOperatorSkill(newSinkWriters(&out, &out), bufio.NewReader(strings.NewReader("")), home, uninstall, cons)
	return out.String(), err
}

func TestOperatorSkillInstallBothPlacements(t *testing.T) {
	stubClaudeOnPath(t, true)
	home := t.TempDir()
	if _, err := runOperatorSkill(t, home, false, consent{yes: true}); err != nil {
		t.Fatal(err)
	}
	for _, claude := range []bool{false, true} {
		path := operatorSkillPath(home, claude)
		if got := readFileOrEmpty(t, path); got != operatorSkillContent(claude) {
			t.Errorf("%s =\n%s\nwant\n%s", path, got, operatorSkillContent(claude))
		}
	}
	if !strings.Contains(operatorSkillContent(true), "disable-model-invocation: true") {
		t.Error("the claude copy must disable model invocation")
	}
	if strings.Contains(operatorSkillContent(false), "disable-model-invocation") {
		t.Error("the harness-neutral copy must keep to the portable frontmatter fields")
	}
	for _, claude := range []bool{false, true} {
		c := operatorSkillContent(claude)
		if !strings.Contains(c, "name: operator\n") || !strings.Contains(c, "rk skill operator") || !strings.Contains(c, operatorSkillMarker) {
			t.Errorf("skill content missing name, pointer, or marker:\n%s", c)
		}
	}
}

func TestOperatorSkillClaudeCopyGatedOnPath(t *testing.T) {
	stubClaudeOnPath(t, false)
	home := t.TempDir()
	out, err := runOperatorSkill(t, home, false, consent{yes: true})
	if err != nil {
		t.Fatal(err)
	}
	if readFileOrEmpty(t, operatorSkillPath(home, false)) == "" {
		t.Error("the ~/.agents copy is unconditional")
	}
	if _, err := os.Stat(filepath.Dir(operatorSkillPath(home, true))); !os.IsNotExist(err) {
		t.Errorf("no claude skills dir may be created without claude on PATH (stat err %v)", err)
	}
	if !strings.Contains(out, "claude binary is not on PATH") {
		t.Errorf("output = %q, want the skip note", out)
	}
}

func TestOperatorSkillIdempotent(t *testing.T) {
	stubClaudeOnPath(t, true)
	home := t.TempDir()
	if _, err := runOperatorSkill(t, home, false, consent{yes: true}); err != nil {
		t.Fatal(err)
	}
	out, err := runOperatorSkill(t, home, false, consent{yes: true})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Count(out, "already installed") != 2 || strings.Contains(out, "wrote") {
		t.Errorf("re-run output = %q, want two no-op lines and no writes", out)
	}
}

func TestOperatorSkillDryRunWritesNothing(t *testing.T) {
	stubClaudeOnPath(t, true)
	home := t.TempDir()
	out, err := runOperatorSkill(t, home, false, consent{yes: true, dryRun: true})
	if err != nil {
		t.Fatal(err)
	}
	for _, claude := range []bool{false, true} {
		if _, err := os.Stat(operatorSkillPath(home, claude)); !os.IsNotExist(err) {
			t.Errorf("dry run wrote %s (stat err %v)", operatorSkillPath(home, claude), err)
		}
	}
	if !strings.Contains(out, "+++ proposed") {
		t.Errorf("dry run output = %q, want the proposed body", out)
	}
}

func TestOperatorSkillNonInteractiveRefuses(t *testing.T) {
	stubClaudeOnPath(t, false)
	_, err := runOperatorSkill(t, t.TempDir(), false, consent{})
	if !errors.Is(err, errNonInteractiveConsent) {
		t.Errorf("err = %v, want errNonInteractiveConsent", err)
	}
}

// A file at the placement path without the marker is the user's: never
// overwritten on install, never removed on uninstall.
func TestOperatorSkillForeignFileUntouched(t *testing.T) {
	stubClaudeOnPath(t, false)
	home := t.TempDir()
	path := operatorSkillPath(home, false)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	const mine = "---\nname: operator\n---\nmy own skill\n"
	if err := os.WriteFile(path, []byte(mine), 0o644); err != nil {
		t.Fatal(err)
	}
	for _, uninstall := range []bool{false, true} {
		if _, err := runOperatorSkill(t, home, uninstall, consent{yes: true}); err != nil {
			t.Fatal(err)
		}
		if got := readFileOrEmpty(t, path); got != mine {
			t.Errorf("uninstall=%v rewrote the user's file: %q", uninstall, got)
		}
	}
}

// Uninstall is not gated on claude, removes only SKILL.md, and prunes the
// directory only when nothing else is in it.
func TestOperatorSkillUninstall(t *testing.T) {
	stubClaudeOnPath(t, true)
	home := t.TempDir()
	if _, err := runOperatorSkill(t, home, false, consent{yes: true}); err != nil {
		t.Fatal(err)
	}
	extra := filepath.Join(filepath.Dir(operatorSkillPath(home, true)), "notes.md")
	if err := os.WriteFile(extra, []byte("mine"), 0o644); err != nil {
		t.Fatal(err)
	}
	stubClaudeOnPath(t, false)
	if _, err := runOperatorSkill(t, home, true, consent{yes: true}); err != nil {
		t.Fatal(err)
	}
	for _, claude := range []bool{false, true} {
		if _, err := os.Stat(operatorSkillPath(home, claude)); !os.IsNotExist(err) {
			t.Errorf("%s survived uninstall (stat err %v)", operatorSkillPath(home, claude), err)
		}
	}
	if _, err := os.Stat(filepath.Dir(operatorSkillPath(home, false))); !os.IsNotExist(err) {
		t.Errorf("empty ~/.agents operator dir not pruned (stat err %v)", err)
	}
	if readFileOrEmpty(t, extra) != "mine" {
		t.Error("a user file beside the claude SKILL.md was removed")
	}
}
