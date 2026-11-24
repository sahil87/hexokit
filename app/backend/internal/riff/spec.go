package riff

import (
	"fmt"
	"sort"
	"strings"
)

// RiffPreset is one resolved riff preset: a name and the single skill it renders
// into one skill pane. An empty Skill is the bare launcher.
type RiffPreset struct {
	Name  string
	Skill string
}

// Panes renders the preset as its single skill pane.
func (p RiffPreset) Panes() []PaneSpec {
	return []PaneSpec{{Kind: PaneKindSkill, Value: p.Skill}}
}

// ResolveActiveRiffPreset determines which riff preset (if any) applies to a CLI
// invocation. Returns the riff preset, the remaining positional args after any
// riff-preset consumption, and an error on ambiguous/unknown inputs. Exported so the
// CLI (which owns positional/flag parsing) can call it.
//
// Rules:
//   - Both --riff-preset and a matching positional → error (mutually exclusive).
//   - --riff-preset provided and unknown → error (lists defined riff presets).
//   - Positional matches a defined riff preset exactly → consume arg[0].
//   - Else no riff preset applies; args returned untouched.
func ResolveActiveRiffPreset(args []string, positionalCandidate, riffPresetFlag string, available map[string]string) (*RiffPreset, []string, error) {
	positionalMatch := positionalCandidate != "" && hasRiffPreset(available, positionalCandidate)

	if riffPresetFlag != "" && positionalMatch {
		return nil, args, fmt.Errorf("run-kit riff: positional riff preset %q and --riff-preset %q are mutually exclusive", positionalCandidate, riffPresetFlag)
	}
	if riffPresetFlag != "" {
		skill, ok := available[riffPresetFlag]
		if !ok {
			return nil, args, fmt.Errorf("run-kit riff: unknown riff preset %q (defined: %s)", riffPresetFlag, joinRiffPresetNames(available))
		}
		return &RiffPreset{Name: riffPresetFlag, Skill: skill}, args, nil
	}
	if positionalMatch {
		return &RiffPreset{Name: positionalCandidate, Skill: available[positionalCandidate]}, args[1:], nil
	}
	return nil, args, nil
}

func hasRiffPreset(available map[string]string, name string) bool {
	_, ok := available[name]
	return ok
}

// joinRiffPresetNames returns a comma-separated sorted list of riff preset
// names, or `(none)` if the map is empty.
func joinRiffPresetNames(m map[string]string) string {
	if len(m) == 0 {
		return "(none)"
	}
	names := make([]string, 0, len(m))
	for k := range m {
		names = append(names, k)
	}
	sort.Strings(names)
	return strings.Join(names, ", ")
}

// composePanes maps the HTTP endpoint's (task, riff preset) pair to the CLI-pane
// input for ResolveEffectiveSpec — the endpoint's task-injection composition
// rules (R6/R7), as a pure, table-testable seam:
//
//   - task non-empty  → a single skill pane carrying the task as its launcher
//     positional arg. This REPLACES the preset's pane (per
//     ResolveEffectiveSpec rule 1).
//   - task empty, preset → nil CLI panes, so ResolveEffectiveSpec falls through
//     to the preset's own pane.
//   - task empty, no preset → a single BARE skill pane (the endpoint's
//     blank-agent default — deliberately NOT the CLI's /fab-discuss change-2
//     fallback, which only fires when NO cliPanes are supplied).
//
// A nil returned slice means "let the preset/default decide"; a non-nil slice
// means "these panes replace the preset's".
func composePanes(task string, preset *RiffPreset) []PaneSpec {
	switch {
	case task != "":
		return []PaneSpec{{Kind: PaneKindSkill, Value: task}}
	case preset == nil:
		return []PaneSpec{{Kind: PaneKindSkill, Value: ""}}
	default:
		return nil
	}
}

// ResolveEffectiveSpec merges CLI-style panes with an optional preset into an
// EffectiveSpec. Resolution order per field:
//
//	panes:   CLI (replaces) > preset > built-in default single-pane
//	layout:  explicit layout (incl. "auto") > default auto-by-count
//	count:   CLI count
//	wt args: the CLI passthrough (presets carry none)
//
// layoutExplicit distinguishes "user didn't set a layout" from "user explicitly
// chose auto"; both now resolve through autoLayout — the flag exists so an
// explicit non-auto layout wins. Single-pane windows have their layout forced
// empty regardless of source.
//
// NOTE: the "no panes anywhere → single DefaultRiffSkill pane" default is the
// CLI's change-2 compatibility fallback. Spawn (the HTTP path) supplies its own
// cliPanes (a bare or task skill pane) BEFORE calling this, so it never reaches
// that fallback — the endpoint's blank-agent default is a bare launcher, not
// /fab-discuss.
func ResolveEffectiveSpec(cliPanes []PaneSpec, layoutExplicit bool, layoutCanonical string, cliCount int, preset *RiffPreset, passthrough []string) (EffectiveSpec, error) {
	spec := EffectiveSpec{Count: cliCount}

	switch {
	case len(cliPanes) > 0:
		spec.Panes = append(spec.Panes, cliPanes...)
	case preset != nil:
		spec.Panes = append(spec.Panes, preset.Panes()...)
	default:
		spec.Panes = []PaneSpec{{Kind: PaneKindSkill, Value: DefaultRiffSkill}}
	}

	switch {
	case layoutExplicit && layoutCanonical != "auto":
		spec.Layout = layoutCanonical
	default:
		spec.Layout = autoLayout(len(spec.Panes))
	}

	if len(spec.Panes) <= 1 {
		spec.Layout = ""
	}

	spec.Passthrough = append(spec.Passthrough, passthrough...)

	return spec, nil
}

// ApplySkillPrefix renders every skill pane's non-empty Value through
// RenderSkillRef with spec.SkillPrefix, returning the rendered spec. It is the
// ONE normalization point for provider-specific skill syntax, invoked at the
// two spec-finalization seams (Spawn after ResolveEffectiveSpec, the CLI after
// spec assembly) so composition and typed delivery stay pure readers of
// already-rendered values. An empty SkillPrefix behaves as "/" — a spec
// constructed without resolution is returned byte-identical. Pure.
func ApplySkillPrefix(spec EffectiveSpec) EffectiveSpec {
	out := spec
	out.Panes = make([]PaneSpec, len(spec.Panes))
	for i, pane := range spec.Panes {
		if pane.Kind == PaneKindSkill && pane.Value != "" {
			pane.Value = RenderSkillRef(spec.SkillPrefix, pane.Value)
		}
		out.Panes[i] = pane
	}
	return out
}
