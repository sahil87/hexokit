package fabsysconfig

// presets.go — agent preset definitions (agent_presets.<name>.*) written
// through `fab config set|unset --system`, the multi-write operations built on
// them (duplicate, rename, delete, leftover move/clear) and the per-role
// resolution of one preset. fab has no multi-key transaction, so every
// operation validates fully before its first exec, runs its writes in a fixed
// create-before-remove order under applyMu, and reports which writes landed
// when one fails.

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync"

	"gopkg.in/yaml.v3"

	namevalidate "rk/internal/validate"
)

const (
	presetsKeyPrefix     = "agent_presets."
	presetFieldDesc      = "description"
	presetFieldSession   = "session"
	presetFieldWorkers   = "workers"
	presetProfilesPrefix = "profiles."
	sourceBuiltIn        = "built-in"
	errLastField         = "a preset needs at least one setting — delete it instead"
	errBuiltInReadOnly   = "built-in presets are read-only; duplicate it to change it"
	errNotInSystemConfig = "only presets in your machine config can be changed"
	errPresetNone        = `"none" is reserved; it means no preset`
	envPresetWarningTmpl = "agent.preset is set to %q in the daemon's environment; HexoKit cannot change it"
	presetFlag           = "--preset"
	outputFlag           = "-o"
	outputYAML           = "yaml"
	agentVerb            = "agent"
)

// presetProfileLeaves are the leaves fab accepts under a preset's
// profiles.<role>; the legacy tool/provider spellings are refused there.
var presetProfileLeaves = []string{profileLeafCLI, profileLeafModel, profileLeafEffort}

// PartialWriteError reports a multi-write operation that stopped at its first
// failing step (HTTP 502). Landed lists the steps already durable.
type PartialWriteError struct {
	Landed []string
	Failed string
	Stderr string
}

func (e *PartialWriteError) Error() string {
	msg := e.Failed + " failed"
	if e.Stderr != "" {
		msg += ": " + e.Stderr
	}
	if len(e.Landed) > 0 {
		msg += ". Already done: " + strings.Join(e.Landed, "; ")
	}
	return msg
}

// BindingsError reports a failure to list the tmux options naming a preset
// (HTTP 502). It is raised before any write, so nothing changed.
type BindingsError struct{ Err error }

func (e *BindingsError) Error() string {
	return "could not list the workspace and group agent-preset options; nothing was changed: " + e.Err.Error()
}

func (e *BindingsError) Unwrap() error { return e.Err }

// PresetBinding is one tmux option naming an agent preset: a workspace's
// (@rk_srv_agent_preset) when Session is empty, else a group's
// (@rk_ses_agent_preset).
type PresetBinding struct {
	Server  string
	Session string
	Preset  string
}

// Label names the binding in step reports.
func (b PresetBinding) Label() string {
	if b.Session == "" {
		return "workspace " + b.Server
	}
	return "group " + b.Session + " (" + b.Server + ")"
}

// PresetBindings is the tmux side of rename and delete: it lists every
// workspace and group option naming a preset on the servers the daemon covers,
// and sets or clears one. The package stays tmux-agnostic behind it.
type PresetBindings interface {
	List(ctx context.Context) ([]PresetBinding, error)
	Set(ctx context.Context, b PresetBinding, name string) error
	Clear(ctx context.Context, b PresetBinding) error
}

// ---- key validation ----

// splitPresetKey splits agent_presets.<name>[.<field>] into name and field
// (empty for the whole-preset key). A preset name is an identifier and holds no
// dot, so the first dot after the prefix ends it.
func splitPresetKey(key string) (name, field string) {
	rest := strings.TrimPrefix(key, presetsKeyPrefix)
	name, field, _ = strings.Cut(rest, ".")
	return name, field
}

// checkPresetFieldPath accepts description, session, workers and
// profiles.<role>.{cli,model,effort}.
func checkPresetFieldPath(field string) error {
	switch field {
	case presetFieldDesc, presetFieldSession, presetFieldWorkers:
		return nil
	}
	rest, ok := strings.CutPrefix(field, presetProfilesPrefix)
	if ok {
		role, leaf, found := strings.Cut(rest, ".")
		if found && roleKnown(role) {
			switch {
			case contains(presetProfileLeaves, leaf):
				return nil
			case contains(toolLeaves, leaf):
				return errors.New("a preset's tool leaf is spelled cli")
			}
		}
	}
	return errors.New("unknown preset field")
}

func roleKnown(role string) bool {
	for _, rd := range Roles {
		if rd.Name == role {
			return true
		}
	}
	return false
}

// checkPresetName is the name rule every preset write shares: the identifier
// allowlist, not the reserved none, not a built-in's name.
func checkPresetName(name string, presets presetList) error {
	if err := checkNameShape(name); err != nil {
		return err
	}
	if !presets.ok {
		return ErrPresetsUnsupported
	}
	if p, ok := findPreset(presets.presets, name); ok {
		switch p.Source {
		case sourceBuiltIn:
			return errors.New(errBuiltInReadOnly)
		case originSystem:
		default:
			return errors.New(errNotInSystemConfig)
		}
	}
	return nil
}

// checkNameShape is the rule on the name alone: the identifier allowlist (no
// leading dash, so it never reaches argv as a flag) and not the reserved none.
func checkNameShape(name string) error {
	if msg := namevalidate.ValidateAgentPresetName(name); msg != "" {
		return errors.New(msg)
	}
	if name == presetNone {
		return errors.New(errPresetNone)
	}
	return nil
}

func findPreset(presets []AgentPreset, name string) (AgentPreset, bool) {
	for _, p := range presets {
		if p.Name == name {
			return p, true
		}
	}
	return AgentPreset{}, false
}

// validatePresetKey validates one agent_presets.* patch entry into an op.
func validatePresetKey(key string, raw json.RawMessage, tools []string, presets presetList) (op, error) {
	name, field := splitPresetKey(key)
	if strings.HasSuffix(key, ".") {
		return op{}, errors.New("unknown preset field")
	}
	if err := checkPresetName(name, presets); err != nil {
		return op{}, err
	}
	isNull := string(bytes.TrimSpace(raw)) == "null"
	if field == "" {
		if !isNull {
			return op{}, errors.New("a whole preset can only be removed (null)")
		}
		return op{key: key}, nil
	}
	if err := checkPresetFieldPath(field); err != nil {
		return op{}, err
	}
	if isNull {
		return op{key: key}, nil
	}
	val, err := validatePresetValue(field, raw, tools)
	if err != nil {
		return op{}, err
	}
	if val == nil { // empty non-description leaf == unset
		return op{key: key}, nil
	}
	return op{key: key, value: val}, nil
}

// validatePresetValue checks one preset leaf. An empty string unsets every
// leaf but the description, which fab refuses empty.
func validatePresetValue(field string, raw json.RawMessage, tools []string) (*string, error) {
	var s string
	if err := json.Unmarshal(raw, &s); err != nil {
		return nil, errors.New("must be a string")
	}
	s = strings.TrimSpace(s)
	if s == "" && field != presetFieldDesc {
		return nil, nil
	}
	if err := checkFreeText(s); err != nil {
		return nil, err
	}
	if isPresetToolField(field) && !contains(tools, s) {
		return nil, fmt.Errorf("unknown CLI %q (available: %s)", s, strings.Join(tools, ", "))
	}
	return &s, nil
}

func isPresetToolField(field string) bool {
	return field == presetFieldSession || field == presetFieldWorkers ||
		strings.HasSuffix(field, "."+profileLeafCLI)
}

// checkPresetOps enforces what only the whole patch shows: a preset is removed
// alone, and an unset never leaves a listed preset without a field (fab
// deletes a preset whose last leaf is unset).
func checkPresetOps(ops []op, presets presetList) error {
	byName := map[string][]op{}
	for _, o := range ops {
		if !strings.HasPrefix(o.key, presetsKeyPrefix) {
			continue
		}
		name, _ := splitPresetKey(o.key)
		byName[name] = append(byName[name], o)
	}
	names := make([]string, 0, len(byName))
	for n := range byName {
		names = append(names, n)
	}
	sort.Strings(names)
	for _, name := range names {
		if err := checkPresetNameOps(name, byName[name], presets); err != nil {
			return &ValidationError{Msg: presetsKeyPrefix + name + ": " + err.Error()}
		}
	}
	return nil
}

func checkPresetNameOps(name string, ops []op, presets presetList) error {
	fields := map[string]string{}
	if p, ok := findPreset(presets.presets, name); ok {
		fields = presetFields(p)
	}
	hadFields := len(fields) > 0
	unsets := false
	for _, o := range ops {
		_, field := splitPresetKey(o.key)
		if field == "" {
			if len(ops) > 1 {
				return errors.New("a preset is removed alone, not together with changes to its fields")
			}
			return nil
		}
		if o.value == nil {
			delete(fields, field)
			unsets = true
		} else {
			fields[field] = *o.value
		}
	}
	if unsets && hadFields && len(fields) == 0 {
		return errors.New(errLastField)
	}
	return nil
}

// presetFields flattens a preset into field path → value, leaving unset
// leaves out.
func presetFields(p AgentPreset) map[string]string {
	fields := map[string]string{}
	set := func(field, v string) {
		if v != "" {
			fields[field] = v
		}
	}
	set(presetFieldDesc, p.Description)
	set(presetFieldSession, p.Session)
	set(presetFieldWorkers, p.Workers)
	for _, rd := range Roles {
		for _, leaf := range presetProfileLeaves {
			set(presetProfilesPrefix+rd.Name+"."+leaf, p.Profiles[rd.Name][leaf])
		}
	}
	return fields
}

// orderedFields lists a field map's paths in write order: description,
// session, workers, then each role's leaves in Roles order.
func orderedFields(fields map[string]string) []string {
	order := []string{presetFieldDesc, presetFieldSession, presetFieldWorkers}
	for _, rd := range Roles {
		for _, leaf := range presetProfileLeaves {
			order = append(order, presetProfilesPrefix+rd.Name+"."+leaf)
		}
	}
	var out []string
	for _, f := range order {
		if _, ok := fields[f]; ok {
			out = append(out, f)
		}
	}
	return out
}

func presetKey(name, field string) string { return presetsKeyPrefix + name + "." + field }

// ---- operation plumbing ----

// opState is what an operation reads once, under applyMu, before its first
// write.
type opState struct {
	byKey   map[string]showRow
	presets []AgentPreset
	tools   []string
}

// load reads fab's config rows and preset list. Callers hold applyMu.
func (c *Client) load(ctx context.Context) (*opState, error) {
	rows, err := c.loadRows(ctx)
	if err != nil {
		return nil, err
	}
	c.writeToolLeaf = probeToolLeaf(rows, nil)
	list := c.listPresets(ctx)
	if !list.ok {
		return nil, ErrPresetsUnsupported
	}
	return &opState{byKey: indexRows(rows), presets: list.presets, tools: toolNames(rows)}, nil
}

// checkNewName validates a name a new preset will take: the name rule and not
// already listed (built-in or not).
func (st *opState) checkNewName(name string) error {
	if err := checkNameShape(name); err != nil {
		return &ValidationError{Msg: err.Error()}
	}
	if _, taken := findPreset(st.presets, name); taken {
		return &ValidationError{Msg: fmt.Sprintf("A preset named %s already exists.", name)}
	}
	return nil
}

// userPreset returns a listed preset defined in the system config.
func (st *opState) userPreset(name string) (AgentPreset, error) {
	if msg := namevalidate.ValidateAgentPresetName(name); msg != "" {
		return AgentPreset{}, &ValidationError{Msg: msg}
	}
	p, ok := findPreset(st.presets, name)
	switch {
	case !ok:
		return AgentPreset{}, &ValidationError{Msg: fmt.Sprintf("unknown agent preset %q", name)}
	case p.Source == sourceBuiltIn:
		return AgentPreset{}, &ValidationError{Msg: errBuiltInReadOnly}
	case p.Source != originSystem:
		return AgentPreset{}, &ValidationError{Msg: errNotInSystemConfig}
	}
	return p, nil
}

// checkFieldValues re-checks every value an operation is about to write, so a
// value copied from a listed preset can never reach argv unvalidated.
func checkFieldValues(fields map[string]string) error {
	for _, f := range orderedFields(fields) {
		if err := checkFreeText(fields[f]); err != nil {
			return &ValidationError{Msg: f + ": " + err.Error()}
		}
	}
	return nil
}

// writeSteps runs an operation's writes in order and tracks what landed.
type writeSteps struct {
	c        *Client
	ctx      context.Context
	landed   []string
	warnings []string
}

func (w *writeSteps) fab(o op) error {
	argv := o.argv()
	desc := strings.Join(argv[1:len(argv)-1], " ")
	_, stderr, err := w.c.run(w.ctx, argv...)
	if err != nil {
		return &PartialWriteError{Landed: w.landed, Failed: desc, Stderr: strings.TrimSpace(string(stderr))}
	}
	w.landed = append(w.landed, desc)
	w.warnings = append(w.warnings, warningLines(stderr)...)
	return nil
}

func (w *writeSteps) tmux(desc string, fn func() error) error {
	if err := fn(); err != nil {
		return &PartialWriteError{Landed: w.landed, Failed: desc, Stderr: err.Error()}
	}
	w.landed = append(w.landed, desc)
	return nil
}

// writePreset writes every field of a preset under name, in write order.
func (w *writeSteps) writePreset(name string, fields map[string]string) error {
	for _, f := range orderedFields(fields) {
		v := fields[f]
		if err := w.fab(op{key: presetKey(name, f), value: &v}); err != nil {
			return err
		}
	}
	return nil
}

// machineDefault is where agent.preset stands: the system-layer value (named
// even when an env value shadows it) and the env value, "" when unset.
func (c *Client) machineDefault(ctx context.Context, byKey map[string]showRow) (system, env string) {
	top, ok := byKey[KeyAgentPreset]
	if !ok {
		return "", ""
	}
	switch top.Origin {
	case originSystem:
		return valueString(top.Value), ""
	case originEnv:
		if v := c.systemValue(ctx, KeyAgentPreset); v != nil {
			system = fmt.Sprint(v)
		}
		return system, valueString(top.Value)
	}
	return "", ""
}

// listBindings returns the tmux options naming name, read before any write so a
// tmux failure leaves everything untouched.
func listBindings(ctx context.Context, bindings PresetBindings, name string) ([]PresetBinding, error) {
	if bindings == nil {
		return nil, nil
	}
	all, err := bindings.List(ctx)
	if err != nil {
		return nil, &BindingsError{Err: err}
	}
	var out []PresetBinding
	for _, b := range all {
		if b.Preset == name {
			out = append(out, b)
		}
	}
	return out, nil
}

// finish re-reads the document outside applyMu and prepends the write
// warnings, like Apply.
func (c *Client) finish(ctx context.Context, warnings []string) (*Document, error) {
	doc, err := c.Read(ctx)
	if err != nil {
		return nil, err
	}
	doc.Warnings = append(warnings, doc.Warnings...)
	return doc, nil
}

// ---- duplicate / rename / delete ----

// DuplicatePreset writes every field of the listed preset from to a new preset
// to (description, when non-empty, replaces the copied one). The result must
// carry a description.
func (c *Client) DuplicatePreset(ctx context.Context, from, to, description string) (*Document, error) {
	if !c.installed() {
		return nil, ErrNotInstalled
	}
	warnings, err := c.duplicate(ctx, from, to, description)
	if err != nil {
		return nil, err
	}
	return c.finish(ctx, warnings)
}

func (c *Client) duplicate(ctx context.Context, from, to, description string) ([]string, error) {
	applyMu.Lock()
	defer applyMu.Unlock()
	st, err := c.load(ctx)
	if err != nil {
		return nil, err
	}
	if msg := namevalidate.ValidateAgentPresetName(from); msg != "" {
		return nil, &ValidationError{Msg: msg}
	}
	src, ok := findPreset(st.presets, from)
	if !ok {
		return nil, &ValidationError{Msg: fmt.Sprintf("unknown agent preset %q", from)}
	}
	if err := st.checkNewName(to); err != nil {
		return nil, err
	}
	fields := presetFields(src)
	if d := strings.TrimSpace(description); d != "" {
		fields[presetFieldDesc] = d
	}
	if fields[presetFieldDesc] == "" {
		return nil, &ValidationError{Msg: "a preset needs a description"}
	}
	if err := checkFieldValues(fields); err != nil {
		return nil, err
	}
	w := &writeSteps{c: c, ctx: ctx}
	if err := w.writePreset(to, fields); err != nil {
		return nil, err
	}
	return w.warnings, nil
}

// RenamePreset renames a user preset from → to: it writes the new preset,
// repoints the machine default and every tmux option naming the old name, then
// removes the old preset. Create-before-remove means a failure part-way leaves
// both names rather than neither.
func (c *Client) RenamePreset(ctx context.Context, from, to string, bindings PresetBindings) (*Document, error) {
	if !c.installed() {
		return nil, ErrNotInstalled
	}
	warnings, err := c.rename(ctx, from, to, bindings)
	if err != nil {
		return nil, err
	}
	return c.finish(ctx, warnings)
}

func (c *Client) rename(ctx context.Context, from, to string, bindings PresetBindings) ([]string, error) {
	applyMu.Lock()
	defer applyMu.Unlock()
	st, err := c.load(ctx)
	if err != nil {
		return nil, err
	}
	src, err := st.userPreset(from)
	if err != nil {
		return nil, err
	}
	if from == to {
		return nil, nil
	}
	if err := st.checkNewName(to); err != nil {
		return nil, err
	}
	fields := presetFields(src)
	if err := checkFieldValues(fields); err != nil {
		return nil, err
	}
	system, env := c.machineDefault(ctx, st.byKey)
	bound, err := listBindings(ctx, bindings, from)
	if err != nil {
		return nil, err
	}

	w := &writeSteps{c: c, ctx: ctx}
	if err := w.writePreset(to, fields); err != nil {
		return nil, err
	}
	if system == from {
		target := to
		if err := w.fab(op{key: KeyAgentPreset, value: &target}); err != nil {
			return nil, err
		}
	}
	for _, b := range bound {
		b := b
		if err := w.tmux("repoint "+b.Label(), func() error { return bindings.Set(ctx, b, to) }); err != nil {
			return nil, err
		}
	}
	if err := w.fab(op{key: presetsKeyPrefix + from}); err != nil {
		return nil, err
	}
	w.warnings = append(w.warnings, envPresetWarning(env, from)...)
	return w.warnings, nil
}

// DeletePreset removes a user preset: it clears the machine default and every
// tmux option naming it, then unsets the whole preset.
func (c *Client) DeletePreset(ctx context.Context, name string, bindings PresetBindings) (*Document, error) {
	if !c.installed() {
		return nil, ErrNotInstalled
	}
	warnings, err := c.delete(ctx, name, bindings)
	if err != nil {
		return nil, err
	}
	return c.finish(ctx, warnings)
}

func (c *Client) delete(ctx context.Context, name string, bindings PresetBindings) ([]string, error) {
	applyMu.Lock()
	defer applyMu.Unlock()
	st, err := c.load(ctx)
	if err != nil {
		return nil, err
	}
	if _, err := st.userPreset(name); err != nil {
		return nil, err
	}
	system, env := c.machineDefault(ctx, st.byKey)
	bound, err := listBindings(ctx, bindings, name)
	if err != nil {
		return nil, err
	}

	w := &writeSteps{c: c, ctx: ctx}
	if system == name {
		if err := w.fab(op{key: KeyAgentPreset}); err != nil {
			return nil, err
		}
	}
	for _, b := range bound {
		b := b
		if err := w.tmux("clear "+b.Label(), func() error { return bindings.Clear(ctx, b) }); err != nil {
			return nil, err
		}
	}
	if err := w.fab(op{key: presetsKeyPrefix + name}); err != nil {
		return nil, err
	}
	w.warnings = append(w.warnings, envPresetWarning(env, name)...)
	return w.warnings, nil
}

// envPresetWarning is the warning for an env-origin agent.preset naming the
// preset an operation just renamed or removed.
func envPresetWarning(env, name string) []string {
	if env != name {
		return nil
	}
	return []string{fmt.Sprintf(envPresetWarningTmpl, name)}
}

// ---- leftover settings ----

// looseValue is one explicit system-layer machine-wide setting that belongs to
// no preset: agent.session, agent.workers or agent.profiles.<role>.<leaf>.
type looseValue struct {
	key   string
	field string // the preset field it maps to
	value string
}

// looseValues lists the system-layer values that no preset supplied, in a
// stable order. The legacy tool/provider leaves map to a preset's cli; where
// fab shows both spellings the new one is listed last, so it wins an overlay.
func looseValues(byKey map[string]showRow) []looseValue {
	var out []looseValue
	add := func(key, field string) {
		r, ok := byKey[key]
		if !ok || r.Origin != originSystem || presetOf(r.OriginDetail) != "" {
			return
		}
		if v := valueString(r.Value); v != "" {
			out = append(out, looseValue{key: key, field: field, value: v})
		}
	}
	add(KeyAgentSession, presetFieldSession)
	add(KeyAgentWorkers, presetFieldWorkers)
	for _, rd := range Roles {
		base := profileKeyPrefix + rd.Name + "."
		for _, leaf := range []string{profileLeafProvider, profileLeafTool, profileLeafCLI} {
			add(base+leaf, presetProfilesPrefix+rd.Name+"."+profileLeafCLI)
		}
		add(base+profileLeafModel, presetProfilesPrefix+rd.Name+"."+profileLeafModel)
		add(base+profileLeafEffort, presetProfilesPrefix+rd.Name+"."+profileLeafEffort)
	}
	return out
}

// MoveLeftovers creates preset name holding the machine default preset's
// fields overlaid with the loose values, makes it the machine default, then
// unsets the loose keys, so the machine-wide result is unchanged.
func (c *Client) MoveLeftovers(ctx context.Context, name, description string) (*Document, error) {
	if !c.installed() {
		return nil, ErrNotInstalled
	}
	warnings, err := c.moveLeftovers(ctx, name, description)
	if err != nil {
		return nil, err
	}
	return c.finish(ctx, warnings)
}

func (c *Client) moveLeftovers(ctx context.Context, name, description string) ([]string, error) {
	applyMu.Lock()
	defer applyMu.Unlock()
	st, err := c.load(ctx)
	if err != nil {
		return nil, err
	}
	loose := looseValues(st.byKey)
	if len(loose) == 0 {
		return nil, &ValidationError{Msg: "there are no loose settings to move"}
	}
	if err := st.checkNewName(name); err != nil {
		return nil, err
	}
	desc := strings.TrimSpace(description)
	if err := checkFreeText(desc); err != nil {
		return nil, &ValidationError{Msg: "description: " + err.Error()}
	}
	fields := map[string]string{}
	if top, ok := st.byKey[KeyAgentPreset]; ok {
		if base, listed := findPreset(st.presets, valueString(top.Value)); listed {
			fields = presetFields(base)
		}
	}
	for _, l := range loose {
		fields[l.field] = l.value
	}
	fields[presetFieldDesc] = desc
	if err := checkFieldValues(fields); err != nil {
		return nil, err
	}
	_, env := c.machineDefault(ctx, st.byKey)

	w := &writeSteps{c: c, ctx: ctx}
	if err := w.writePreset(name, fields); err != nil {
		return nil, err
	}
	target := name
	if err := w.fab(op{key: KeyAgentPreset, value: &target}); err != nil {
		return nil, err
	}
	if err := w.unsetLoose(loose); err != nil {
		return nil, err
	}
	if env != "" {
		w.warnings = append(w.warnings, fmt.Sprintf(envPresetWarningTmpl, env))
	}
	return w.warnings, nil
}

func (w *writeSteps) unsetLoose(loose []looseValue) error {
	for _, l := range loose {
		if err := w.fab(op{key: l.key}); err != nil {
			return err
		}
	}
	return nil
}

// ClearLeftovers unsets every loose value.
func (c *Client) ClearLeftovers(ctx context.Context) (*Document, error) {
	if !c.installed() {
		return nil, ErrNotInstalled
	}
	warnings, err := c.clearLeftovers(ctx)
	if err != nil {
		return nil, err
	}
	return c.finish(ctx, warnings)
}

func (c *Client) clearLeftovers(ctx context.Context) ([]string, error) {
	applyMu.Lock()
	defer applyMu.Unlock()
	rows, err := c.loadRows(ctx)
	if err != nil {
		return nil, err
	}
	w := &writeSteps{c: c, ctx: ctx}
	if err := w.unsetLoose(looseValues(indexRows(rows))); err != nil {
		return nil, err
	}
	return w.warnings, nil
}

// ---- per-role resolution ----

// ResolvedRole is what one role resolves to when a tab is launched with a
// preset, per fab. A role fab cannot resolve is the zero value.
type ResolvedRole struct {
	CLI    string `json:"cli"`
	Model  string `json:"model"`
	Effort string `json:"effort"`
}

type resolvedYAML struct {
	CLI      string `yaml:"cli"`
	Provider string `yaml:"provider"`
	Model    string `yaml:"model"`
	Effort   string `yaml:"effort"`
}

// ResolvePreset asks fab what each role resolves to under preset name
// (`fab agent <role> --preset <name> -o yaml`), so the dimmed "what applies"
// values match what a tab launched with the preset gets, loose machine-wide
// values included. A role that fails to resolve comes back empty.
func (c *Client) ResolvePreset(ctx context.Context, name string) (map[string]ResolvedRole, error) {
	if !c.installed() {
		return nil, ErrNotInstalled
	}
	if msg := namevalidate.ValidateAgentPresetName(name); msg != "" {
		return nil, &ValidationError{Msg: msg}
	}
	out := make(map[string]ResolvedRole, len(Roles))
	var mu sync.Mutex
	var wg sync.WaitGroup
	for _, rd := range Roles {
		wg.Add(1)
		go func(role string) {
			defer wg.Done()
			r := c.resolveRole(ctx, role, name)
			mu.Lock()
			out[role] = r
			mu.Unlock()
		}(rd.Name)
	}
	wg.Wait()
	return out, nil
}

func (c *Client) resolveRole(ctx context.Context, role, preset string) ResolvedRole {
	stdout, _, err := c.run(ctx, agentVerb, role, presetFlag, preset, outputFlag, outputYAML)
	if err != nil {
		return ResolvedRole{}
	}
	var y resolvedYAML
	if yaml.Unmarshal(stdout, &y) != nil {
		return ResolvedRole{}
	}
	cli := y.CLI
	if cli == "" {
		cli = y.Provider
	}
	return ResolvedRole{CLI: cli, Model: y.Model, Effort: y.Effort}
}
