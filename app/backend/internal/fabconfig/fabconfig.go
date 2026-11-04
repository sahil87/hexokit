// Package fabconfig reads fab-file facts from the fab/project/config.yaml file
// that lives at a repo root: the agent tier NAMES (BuiltinTiers/ReadTiers),
// fab-project detection (IsFabProject), and top-level key presence
// (HasTopLevelKey). It provides best-effort accessors that return empty values
// rather than errors when the file is absent, malformed, or missing keys — the
// same best-effort stance internal/config takes for its RK_* env vars and
// internal/settings takes for ~/.config/hexokit/config.yaml.
//
// The agent launcher is NOT read here: `rk riff` resolves it by shelling out
// to `fab agent -o yaml` (see riff.ResolveAgent), so rk never parses fab-kit's
// tier→provider→session_command schema itself.
package fabconfig

import (
	"os"
	"path/filepath"

	"gopkg.in/yaml.v3"
)

// fabConfigRelPath is the location of the fab config relative to the repo root.
const fabConfigRelPath = "fab/project/config.yaml"

// BuiltinTiers is the fixed set of fab-kit built-in tier names, in the canonical
// order (default first). It mirrors the FIXED stage→tier mapping documented in
// the fab config reference fence — these are always available even when the repo
// config defines no `agent.tiers` block.
var BuiltinTiers = []string{"default", "doing", "fast", "operator", "review"}

// ReadTiers returns the tier names available for a spawn: the union of fab-kit's
// built-in tiers (BuiltinTiers, in canonical order) and any additional names
// defined under `agent.tiers` in <repoRoot>/fab/project/config.yaml, appended in
// YAML source order and deduplicated. It is always non-empty (built-ins alone on
// an empty/absent/malformed config).
//
// Best-effort, the package's silent-fallback posture: any read/parse failure
// yields exactly the built-ins with no error or log. Only the tier NAMES are
// read — rk never parses the tier profiles (provider/model/effort); those are
// resolved by shelling out to `fab agent <tier> -o yaml`.
func ReadTiers(repoRoot string) []string {
	tiers := make([]string, 0, len(BuiltinTiers))
	seen := make(map[string]struct{}, len(BuiltinTiers))
	for _, name := range BuiltinTiers {
		tiers = append(tiers, name)
		seen[name] = struct{}{}
	}

	for _, name := range readConfiguredTierNames(repoRoot) {
		if _, dup := seen[name]; dup {
			continue
		}
		seen[name] = struct{}{}
		tiers = append(tiers, name)
	}
	return tiers
}

// IsFabProject reports whether repoRoot is a fab project — true iff
// <repoRoot>/fab/project/config.yaml exists. It is a single os.Stat: no YAML
// parse, no subprocess (constitution §I/§II — derived from the filesystem at
// request time). An empty repoRoot returns false.
//
// The absent-vs-malformed split is deliberate and complements ReadTiers: an
// ABSENT config means "not a fab project" (callers gate tiers to []), while a
// MALFORMED-but-present config is still a fab project whose ReadTiers falls back
// to the built-ins. IsFabProject answers only the presence question.
func IsFabProject(repoRoot string) bool {
	if repoRoot == "" {
		return false
	}
	_, err := os.Stat(filepath.Join(repoRoot, fabConfigRelPath))
	return err == nil
}

// HasTopLevelKey reports whether <repoRoot>/fab/project/config.yaml parses and
// carries key at its top-level mapping. Best-effort: false on any failure.
func HasTopLevelKey(repoRoot, key string) bool {
	if repoRoot == "" {
		return false
	}
	data, err := os.ReadFile(filepath.Join(repoRoot, fabConfigRelPath))
	if err != nil {
		return false
	}
	var root yaml.Node
	if err := yaml.Unmarshal(data, &root); err != nil {
		return false
	}
	// Root is a DocumentNode wrapping one MappingNode.
	if root.Kind != yaml.DocumentNode || len(root.Content) == 0 {
		return false
	}
	return findMappingValue(root.Content[0], key) != nil
}

// readConfiguredTierNames returns the `agent.tiers` map keys from the repo config
// in YAML source order, or nil on any failure path (silent-fallback).
func readConfiguredTierNames(repoRoot string) []string {
	if repoRoot == "" {
		return nil
	}
	data, err := os.ReadFile(filepath.Join(repoRoot, fabConfigRelPath))
	if err != nil {
		return nil
	}
	var root yaml.Node
	if err := yaml.Unmarshal(data, &root); err != nil {
		return nil
	}
	if root.Kind != yaml.DocumentNode || len(root.Content) == 0 {
		return nil
	}
	top := root.Content[0]
	if top.Kind != yaml.MappingNode {
		return nil
	}
	agentNode := findMappingValue(top, "agent")
	if agentNode == nil || agentNode.Kind != yaml.MappingNode {
		return nil
	}
	tiersNode := findMappingValue(agentNode, "tiers")
	if tiersNode == nil || tiersNode.Kind != yaml.MappingNode {
		return nil
	}
	names := make([]string, 0, len(tiersNode.Content)/2)
	for i := 0; i+1 < len(tiersNode.Content); i += 2 {
		keyNode := tiersNode.Content[i]
		if keyNode.Kind == yaml.ScalarNode && keyNode.Value != "" {
			names = append(names, keyNode.Value)
		}
	}
	return names
}

// findMappingValue returns the value node whose sibling key equals key, or
// nil when no match exists. node must be a MappingNode.
func findMappingValue(node *yaml.Node, key string) *yaml.Node {
	if node == nil || node.Kind != yaml.MappingNode {
		return nil
	}
	for i := 0; i+1 < len(node.Content); i += 2 {
		k := node.Content[i]
		if k.Kind == yaml.ScalarNode && k.Value == key {
			return node.Content[i+1]
		}
	}
	return nil
}
