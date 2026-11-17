package main

import (
	"bufio"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// The operator pointer skill — the one Agent Skill rk agent setup places. Its
// body is a pointer: it tells the agent to run `rk skill operator` and follow
// that output, so the operator chat skill itself stays embedded in the rk
// binary (version-locked with the verbs it documents) and the placed file has
// nothing that can go stale. `rk operator` types `/operator` into the agent it
// launches when the copy that agent's harness reads is rk-owned (see
// operatorKickoff), and falls back to typing the pointer instruction itself.
//
// Placement follows the toolkit's two-tier rule: ~/.agents/skills/ always (the
// harness-neutral directory), ~/.claude/skills/ only when the claude binary is
// on PATH. Uninstall removes both, ungated. A file at either path without the
// ownership marker is the user's and is never written or removed.

const (
	// operatorSkillName is the skill's directory, frontmatter name, and slash
	// command.
	operatorSkillName = "operator"
	operatorSkillFile = "SKILL.md"
	// operatorSkillMarker is the ownership marker in the skill's metadata
	// frontmatter; a file without it is never touched.
	operatorSkillMarker = "managed-by: rk agent setup"
	// operatorSkillLabel prefixes every status line.
	operatorSkillLabel = "operator skill"
)

// operatorSkillDescription is the frontmatter description: activation text for
// a skill that should only ever run when typed explicitly.
const operatorSkillDescription = "HexoKit operator chat: coordinate agents across tmux panes, keep the operator's tracked items and notes, and run autopilot queues. Use only when invoked as /operator in a HexoKit operator window (`rk operator` opens one); loads the chat skill from `rk skill operator`."

// operatorSkillBody is the shared Markdown body below the frontmatter.
const operatorSkillBody = `# /operator

Pointer written by ` + "`rk agent setup`" + `. The operator chat skill ships inside the rk binary, so it always matches the installed version.

Run:

` + "```sh\nrk skill operator\n```" + `

Follow its output as your operator skill for the rest of this session. If ` + "`rk`" + ` is not on PATH or the command fails, tell the user and stop: do not improvise the operator role.
`

// operatorSkillContent renders the placed SKILL.md. The claude copy adds
// disable-model-invocation so Claude Code never auto-activates it; the
// harness-neutral copy keeps to the agentskills.io portable fields.
func operatorSkillContent(claude bool) string {
	var b strings.Builder
	b.WriteString("---\n")
	b.WriteString("name: " + operatorSkillName + "\n")
	fmt.Fprintf(&b, "description: %q\n", operatorSkillDescription)
	if claude {
		b.WriteString("disable-model-invocation: true\n")
	}
	b.WriteString("metadata:\n  " + operatorSkillMarker + "\n")
	b.WriteString("---\n\n")
	b.WriteString(operatorSkillBody)
	return b.String()
}

// operatorSkillPath is the placed skill file for one tier: the claude copy
// under ~/.claude/skills, else the harness-neutral one under ~/.agents/skills.
func operatorSkillPath(home string, claude bool) string {
	root := filepath.Join(home, ".agents", "skills")
	if claude {
		root = filepath.Join(home, ".claude", "skills")
	}
	return filepath.Join(root, operatorSkillName, operatorSkillFile)
}

// operatorSkillOwned reports whether the file at path exists and carries the
// ownership marker. An unreadable file reads as not owned.
func operatorSkillOwned(path string) bool {
	content, exists, err := readFileIfExists(path)
	return err == nil && exists && strings.Contains(content, operatorSkillMarker)
}

// applyOperatorSkill installs (or --uninstall removes) both placements. On
// install the claude copy is gated on the claude binary; uninstall is not
// gated, so removal works after the harness is gone.
func applyOperatorSkill(sink outputSink, reader *bufio.Reader, home string, uninstall bool, cons consent) error {
	for _, claude := range []bool{false, true} {
		path := operatorSkillPath(home, claude)
		var err error
		switch {
		case uninstall:
			err = removeOperatorSkill(sink, reader, path, cons)
		case claude && !agentBinaryOnPath("claude"):
			sink.Notef("%s: skipped %s (the claude binary is not on PATH).\n", operatorSkillLabel, path)
		default:
			err = installOperatorSkill(sink, reader, path, operatorSkillContent(claude), cons)
		}
		if err != nil {
			return err
		}
	}
	return nil
}

// installOperatorSkill writes one placement (0644, parents 0755). A
// marker-less file at the path, including a zero-byte one, is left untouched;
// an identical rk-owned file is a reported no-op.
func installOperatorSkill(sink outputSink, reader *bufio.Reader, path, desired string, cons consent) error {
	current, exists, err := readFileIfExists(path)
	if err != nil {
		return fmt.Errorf("%s: read %s: %w", operatorSkillLabel, path, err)
	}
	if exists && !strings.Contains(current, operatorSkillMarker) {
		sink.Notef("%s: %s exists without the %q marker — leaving it untouched (rk only overwrites files it owns).\n", operatorSkillLabel, path, operatorSkillMarker)
		return nil
	}
	if current == desired {
		sink.Notef("%s: already installed at %s — nothing to do.\n", operatorSkillLabel, path)
		return nil
	}

	if cons.dryRun {
		header := fmt.Sprintf("%s: will install the /%s pointer skill at %s", operatorSkillLabel, operatorSkillName, path)
		renderArtifactDiff(cons.diffWriter(sink), header, strings.TrimSuffix(current, "\n"), strings.TrimSuffix(desired, "\n"))
	} else if exists {
		fmt.Fprintf(cons.diffWriter(sink), "%s: will update the rk-owned /%s skill at %s.\n", operatorSkillLabel, operatorSkillName, path)
	} else {
		fmt.Fprintf(cons.diffWriter(sink), "%s: will install the /%s skill at %s (a pointer to `rk skill operator`).\n", operatorSkillLabel, operatorSkillName, path)
	}
	ok, err := cons.authorizeWrite(sink.data, reader, operatorSkillLabel+": dry run — no skill written.", "\nWrite the operator skill? [y/N] ")
	if err != nil {
		return err
	}
	if !ok {
		if !cons.dryRun {
			sink.Notef("%s: skipped (no skill written).\n", operatorSkillLabel)
		}
		return nil
	}

	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return fmt.Errorf("%s: create %s: %w", operatorSkillLabel, filepath.Dir(path), err)
	}
	if err := os.WriteFile(path, []byte(desired), 0o644); err != nil {
		return fmt.Errorf("%s: write %s: %w", operatorSkillLabel, path, err)
	}
	sink.Notef("%s: wrote %s.\n", operatorSkillLabel, path)
	return nil
}

// removeOperatorSkill removes one rk-owned placement on --uninstall: absent is
// silent, marker-less or unreadable is skipped with a note, and an owned file
// is removed on consent. Only SKILL.md is deleted; its directory is pruned
// only when empty, so files a user added beside it survive.
func removeOperatorSkill(sink outputSink, reader *bufio.Reader, path string, cons consent) error {
	current, exists, err := readFileIfExists(path)
	if err != nil {
		sink.Notef("%s: %s: cannot read (%v) — leaving it untouched.\n", operatorSkillLabel, path, err)
		return nil
	}
	if !exists {
		return nil
	}
	if !strings.Contains(current, operatorSkillMarker) {
		sink.Notef("%s: %s was rewritten without the %q marker — leaving it untouched (rk only removes files it owns).\n", operatorSkillLabel, path, operatorSkillMarker)
		return nil
	}

	sink.Notef("%s: found the /%s skill at %s.\n\n", operatorSkillLabel, operatorSkillName, path)
	ok, err := cons.authorizeWrite(sink.data, reader, operatorSkillLabel+": dry run — skill left in place (nothing removed).", fmt.Sprintf("Remove %s? [y/N] ", path))
	if err != nil {
		return err
	}
	if !ok {
		if !cons.dryRun {
			sink.Notef("%s: left in place (nothing removed).\n", operatorSkillLabel)
		}
		return nil
	}
	if err := os.Remove(path); err != nil {
		return fmt.Errorf("%s: remove %s: %w", operatorSkillLabel, path, err)
	}
	// os.Remove refuses a non-empty directory, so this never deletes anything
	// else (best effort).
	_ = os.Remove(filepath.Dir(path))
	sink.Notef("%s: removed %s.\n", operatorSkillLabel, path)
	return nil
}
