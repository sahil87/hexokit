// Package fabsysconfig surfaces fab-kit's machine-wide config
// (~/.fab-kit/config.yaml) to the settings UI by wrapping the `fab config` CLI
// (constitution §III). It never reads or rewrites the YAML itself — fab owns
// the file, its comment-preserving writes and its value validation — and it
// holds no cache: every Read re-runs fab, so external edits (the user's shell,
// `fab config upgrade`, another tool) always win (§II).
//
// Reads decode fab ≥ 2.28.11's JSON contract:
//
//	fab config show --origin --json        per-leaf {key, value, origin, origin_detail, status, derived_from?}
//	fab config show <key> --origin --json  one key's tier stack, winner first
//	fab config explain --json              per-key {key, default, description, scope, advertise}
//	fab agent models --json                per-(tool, model) {cli|provider, id, label, efforts, default, source}
//	fab agent presets --json               per-preset {name, description, source, session?, workers?, profiles?}
//
// The model rows are the tools' own offering; a fab without the verb (or a
// failing discovery) falls back to the fill values in `fab config show`. A
// tool's reserved row (source "reserved") is not a model: it is the value that
// asks for the tool's own default, carried apart from the suggestions.
//
// The preset list is optional: a fab without `agent presets`, or one whose
// call fails or prints something other than a JSON array, leaves the document
// without agent_presets and every other field unchanged. A leaf a preset
// supplied keeps the layer that chose the preset as its origin and carries an
// origin_detail of "preset <name>"; it is surfaced as Preset and is never an
// override (resetting it would unset nothing).
//
// Writes validate the patch in full first (§I — fab itself rejects most bad
// values but the daemon must not rely on it for subprocess input), then run
// `fab config set|unset <key> [<value>] --system` sequentially. Preset
// definitions (agent_presets.<name>.*) and the multi-write operations built on
// them — duplicate, rename, delete, leftover move/clear, per-role resolution —
// live in presets.go.
//
// fab spells its CLI table `clis:` and a role's tool leaf
// `agent.profiles.<role>.cli`; older fab spells them `providers:` and
// `.provider`, and a fab mid-deprecation may show both. Reads accept either
// spelling (new wins); the document and the patch speak a neutral `tool`
// leaf, mapped on write to the spelling the installed fab emits.
//
// Every subprocess is an argv-slice exec.CommandContext with a timeout and
// Dir=$HOME, so the view is strictly machine-wide (env, system and default
// tiers): a daemon started inside a repo never leaks that repo's project tier.
package fabsysconfig

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode"
)

// FabTimeout bounds each fab invocation (matches riff.FabTimeout).
const FabTimeout = 10 * time.Second

// Config key names the UI surfaces.
const (
	KeyAgentPreset      = "agent.preset"
	KeyAgentSession     = "agent.session"
	KeyAgentWorkers     = "agent.workers"
	KeyDispatchMode     = "dispatch.mode"
	KeyDispatchColWidth = "dispatch.column_width"
	KeyDispatchMinCols  = "dispatch.min_cols"
	KeyDispatchMinRows  = "dispatch.min_rows"
	KeyDispatchReapDone = "dispatch.reap_done"
	profileKeyPrefix    = "agent.profiles."
	clisKeyPrefix       = "clis."
	providersKeyPrefix  = "providers."
	clisTableKey        = "clis"
	systemConfigRelPath = ".fab-kit/config.yaml"
	originEnv           = "env"
	originSystem        = "system"
	depthSession        = "session"
	depthWorkers        = "workers"
	maxProfileValueLen  = 128
	maxColumnWidth      = 99
	warningMarker       = "warning"
	profileLeafTool     = "tool"
	profileLeafCLI      = "cli"
	profileLeafProvider = "provider"
	profileLeafModel    = "model"
	profileLeafEffort   = "effort"
	toolProfileInfix    = ".profiles."
	defaultProfile      = "default"
	interactiveCmdLeaf  = ".interactive_command"
	headlessCmdLeaf     = ".headless_command"
	effortToken         = "{effort}"
	sourceReserved      = "reserved"
	// presetOriginPrefix starts the origin_detail of a leaf a preset supplied.
	presetOriginPrefix = "preset "
	// presetNone is fab's reserved name that selects no preset; fab never lists it.
	presetNone = "none"
)

// ScalarKeys are the v1 non-profile keys, in display order.
var ScalarKeys = []string{
	KeyAgentPreset, KeyAgentSession, KeyAgentWorkers,
	KeyDispatchMode, KeyDispatchColWidth, KeyDispatchMinCols, KeyDispatchMinRows, KeyDispatchReapDone,
}

// roleDef is one fab role and the tier (agent depth) it belongs to.
type roleDef struct{ Name, Depth string }

// Roles lists the six editable roles in display order: the session depth
// (default, operator) then the workers depth (doing, fast, hydrate, review).
var Roles = []roleDef{
	{"default", depthSession}, {"operator", depthSession},
	{"doing", depthWorkers}, {"fast", depthWorkers}, {"hydrate", depthWorkers}, {"review", depthWorkers},
}

// DispatchModes is fab's closed dispatch.mode set.
var DispatchModes = []string{"pane", "native", "headless"}

// EffortSuggestions is the effort select's option list; fab exposes no enum.
var EffortSuggestions = []string{"low", "medium", "high", "xhigh", "max"}

// toolTablePrefixes and toolLeafSpellings list fab's spellings newest first,
// so every read prefers the new one when fab emits both.
var (
	toolTablePrefixes = []string{clisKeyPrefix, providersKeyPrefix}
	toolLeafSpellings = []string{profileLeafCLI, profileLeafProvider}
)

// toolLeaves are the accepted patch spellings of a role's tool leaf: the
// neutral one the SPA sends plus fab's two.
var toolLeaves = []string{profileLeafTool, profileLeafCLI, profileLeafProvider}

var profileLeaves = append(append([]string{}, toolLeaves...), profileLeafModel, profileLeafEffort)

// Runner executes one fab argv and returns its stdout and stderr separately.
// It is the test seam: unit tests inject a fake so the real binary — and the
// developer's real ~/.fab-kit/config.yaml — is never touched.
type Runner func(ctx context.Context, argv ...string) (stdout, stderr []byte, err error)

// ValidationError marks a patch rejected before any exec (HTTP 400).
type ValidationError struct{ Msg string }

func (e *ValidationError) Error() string { return e.Msg }

// CommandError marks a fab invocation that exited non-zero (HTTP 502); Stderr
// is fab's own message, surfaced verbatim to the row that triggered it.
type CommandError struct {
	Argv   []string
	Stderr string
}

func (e *CommandError) Error() string {
	if e.Stderr != "" {
		return e.Stderr
	}
	return "fab " + strings.Join(e.Argv, " ") + " failed"
}

// ErrNotInstalled is returned by Apply when fab is not on PATH.
var ErrNotInstalled = errors.New("fab is not installed")

// Client wraps the fab CLI. The zero value is not usable; use New or NewClient.
type Client struct {
	run      Runner
	lookPath func(string) (string, error)
	home     func() (string, error)
	// writeToolLeaf is fab's spelling of the role tool leaf ("cli" or
	// "provider"), probed by each Read and Apply. The API builds a Client per
	// request, so a fab upgrade is honoured on the next request.
	writeToolLeaf string
}

// NewClient returns a Client that runs the real fab binary from $HOME.
func NewClient() *Client {
	c := &Client{lookPath: exec.LookPath, home: os.UserHomeDir}
	c.run = c.execRunner
	return c
}

// New returns a Client over an injected runner, always "installed" — the test
// constructor.
func New(run Runner) *Client {
	return &Client{
		run:      run,
		lookPath: func(string) (string, error) { return "fab", nil },
		home:     func() (string, error) { return "/home/test", nil },
	}
}

// WithLookPath overrides fab detection (tests).
func (c *Client) WithLookPath(f func(string) (string, error)) *Client {
	c.lookPath = f
	return c
}

func (c *Client) execRunner(ctx context.Context, argv ...string) ([]byte, []byte, error) {
	ctx, cancel := context.WithTimeout(ctx, FabTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, "fab", argv...)
	if home, err := c.home(); err == nil {
		cmd.Dir = home
	}
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()
	return stdout.Bytes(), stderr.Bytes(), err
}

func (c *Client) installed() bool {
	_, err := c.lookPath("fab")
	return err == nil
}

// ---- document ----

// Field is one scalar key's effective value and provenance.
type Field struct {
	Value        any    `json:"value"`
	Origin       string `json:"origin"`
	OriginDetail string `json:"originDetail,omitempty"`
	// SystemValue is the system-tier value shadowed by an env winner.
	SystemValue any    `json:"systemValue,omitempty"`
	Description string `json:"description,omitempty"`
	// Preset names the preset that supplied this value; such a value is never
	// an override.
	Preset string `json:"preset,omitempty"`
}

// Cell is one role leaf (tool, model or effort).
type Cell struct {
	// Override is set only when the system tier itself set the leaf — never
	// for a value a preset supplied.
	Override     *string `json:"override"`
	Effective    string  `json:"effective"`
	Source       string  `json:"source"`
	Origin       string  `json:"origin"`
	OriginDetail string  `json:"originDetail,omitempty"`
	// Inherited is what the leaf resolves to with no override: the depth knob
	// for the tool; for model/effort the resolved tool's fill for this role,
	// else its default-profile fill (fab's own fallback order).
	Inherited string `json:"inherited"`
	// SystemValue is the system-tier value shadowed by an env winner.
	SystemValue *string `json:"systemValue,omitempty"`
	// Preset names the preset that supplied this leaf.
	Preset string `json:"preset,omitempty"`
}

// Role is one row of the per-role override table.
type Role struct {
	Role   string `json:"role"`
	Depth  string `json:"depth"`
	Tool   Cell   `json:"tool"`
	Model  Cell   `json:"model"`
	Effort Cell   `json:"effort"`
}

// Document is the GET /api/fab-config payload.
type Document struct {
	Installed  bool     `json:"installed"`
	SystemPath string   `json:"systemPath,omitempty"`
	Tools      []string `json:"tools,omitempty"`
	// AgentPresets is `fab agent presets --json`; omitted when the installed
	// fab cannot list presets.
	AgentPresets      []AgentPreset                `json:"agent_presets,omitempty"`
	Fields            map[string]Field             `json:"fields,omitempty"`
	Roles             []Role                       `json:"roles,omitempty"`
	ModelSuggestions  map[string][]ModelSuggestion `json:"modelSuggestions,omitempty"`
	EffortSuggestions []string                     `json:"effortSuggestions,omitempty"`
	// ToolDefaults is each tool's reserved "use the tool's own default" model
	// value from `fab agent models`: ID is the value to write, Label names the
	// discovered default, Efforts are the default model's. A tool fab reports
	// no reserved row for has no entry.
	ToolDefaults map[string]ModelSuggestion `json:"toolDefaults,omitempty"`
	// EffortCapable says per tool whether its interactive or headless
	// command carries {effort}; without it an effort is never substituted.
	EffortCapable map[string]bool `json:"effortCapable,omitempty"`
	// Warnings are fab's stderr warning lines: discovery warnings on every
	// Read, plus the write calls' warnings on an Apply.
	Warnings []string `json:"warnings,omitempty"`
}

// AgentPreset is one named role assignment from `fab agent presets --json`.
// Fields a preset does not set are omitted.
type AgentPreset struct {
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
	// Source is built-in | system | project | env.
	Source  string `json:"source"`
	Session string `json:"session,omitempty"`
	Workers string `json:"workers,omitempty"`
	// Profiles maps role → {cli, model, effort}.
	Profiles map[string]map[string]string `json:"profiles,omitempty"`
}

// ModelSuggestion is one model a tool offers, as `fab agent models` reports it.
type ModelSuggestion struct {
	ID string `json:"id"`
	// Label is omitted when it equals ID.
	Label string `json:"label,omitempty"`
	// Efforts is what this model takes; omitted when unknown.
	Efforts []string `json:"efforts,omitempty"`
	// Default marks the tool's own default model.
	Default bool `json:"default,omitempty"`
}

type derivedFrom struct {
	Key string `json:"key"`
}

type showRow struct {
	Key          string          `json:"key"`
	Value        json.RawMessage `json:"value"`
	Origin       string          `json:"origin"`
	OriginDetail string          `json:"origin_detail"`
	Status       string          `json:"status"`
	DerivedFrom  *derivedFrom    `json:"derived_from"`
}

// modelRow is one `fab agent models --json` row. fab spells the tool field
// `cli`; a fab that predates the rename spells it `provider`.
type modelRow struct {
	CLI      string   `json:"cli"`
	Provider string   `json:"provider"`
	ID       string   `json:"id"`
	Label    string   `json:"label"`
	Efforts  []string `json:"efforts"`
	Default  bool     `json:"default"`
	Source   string   `json:"source"`
}

func (r modelRow) tool() string {
	if r.CLI != "" {
		return r.CLI
	}
	return r.Provider
}

func (r modelRow) suggestion() ModelSuggestion {
	s := ModelSuggestion{ID: r.ID, Default: r.Default}
	if len(r.Efforts) > 0 {
		s.Efforts = r.Efforts
	}
	if r.Label != r.ID {
		s.Label = r.Label
	}
	return s
}

type explainRow struct {
	Key         string `json:"key"`
	Description string `json:"description"`
}

func decodeValue(raw json.RawMessage) any {
	var v any
	if err := json.Unmarshal(raw, &v); err != nil {
		return nil
	}
	return v
}

func valueString(raw json.RawMessage) string {
	switch v := decodeValue(raw).(type) {
	case string:
		return v
	case nil:
		return ""
	case float64:
		return strconv.FormatFloat(v, 'f', -1, 64)
	default:
		return fmt.Sprint(v)
	}
}

func (c *Client) fab(ctx context.Context, argv ...string) ([]byte, error) {
	stdout, stderr, err := c.run(ctx, argv...)
	if err != nil {
		return nil, &CommandError{Argv: argv, Stderr: strings.TrimSpace(string(stderr))}
	}
	return stdout, nil
}

func (c *Client) loadRows(ctx context.Context) ([]showRow, error) {
	out, err := c.fab(ctx, "config", "show", "--origin", "--json")
	if err != nil {
		return nil, err
	}
	var rows []showRow
	if err := json.Unmarshal(out, &rows); err != nil {
		return nil, fmt.Errorf("decode fab config show: %w", err)
	}
	return rows, nil
}

// toolNames derives the tool set from the clis.<name>.* and
// providers.<name>.* leaves — never a hard-coded list, so a kit that ships a
// new tool appears at once.
func toolNames(rows []showRow) []string {
	seen := map[string]struct{}{}
	for _, r := range rows {
		for _, prefix := range toolTablePrefixes {
			rest, ok := strings.CutPrefix(r.Key, prefix)
			if !ok {
				continue
			}
			if name, _, found := strings.Cut(rest, "."); found && name != "" {
				seen[name] = struct{}{}
			}
		}
	}
	names := make([]string, 0, len(seen))
	for n := range seen {
		names = append(names, n)
	}
	sort.Strings(names)
	return names
}

// Read builds the document from fresh fab output. A missing fab is
// {Installed:false} with no error.
func (c *Client) Read(ctx context.Context) (*Document, error) {
	if !c.installed() {
		return &Document{Installed: false}, nil
	}
	// Discovery can take its own timeout (codex), so it runs alongside the
	// config reads and is joined before suggestions are built.
	discovered := make(chan discovery, 1)
	go func() { discovered <- c.discoverModels(ctx) }()
	listed := make(chan presetList, 1)
	go func() { listed <- c.listPresets(ctx) }()

	rows, err := c.loadRows(ctx)
	if err != nil {
		<-discovered
		<-listed
		return nil, err
	}
	byKey := indexRows(rows)
	descriptions := c.descriptions(ctx)
	c.writeToolLeaf = probeToolLeaf(rows, descriptions)

	doc := &Document{
		Installed:         true,
		SystemPath:        c.systemPath(rows),
		Tools:             toolNames(rows),
		Fields:            map[string]Field{},
		ModelSuggestions:  map[string][]ModelSuggestion{},
		EffortSuggestions: EffortSuggestions,
		EffortCapable:     map[string]bool{},
	}
	found := <-discovered
	if found.ok {
		doc.ModelSuggestions = discoveredSuggestions(found.rows, doc.Tools)
		doc.ToolDefaults = discoveredToolDefaults(found.rows, doc.Tools)
		doc.Warnings = found.warnings
	}
	if presets := <-listed; presets.ok {
		doc.AgentPresets = presets.presets
		doc.Warnings = appendUnique(doc.Warnings, presets.warnings)
	}
	for _, t := range doc.Tools {
		if !found.ok {
			doc.ModelSuggestions[t] = modelSuggestions(rows, t)
		}
		doc.EffortCapable[t] = effortCapable(byKey, t)
	}

	for _, key := range ScalarKeys {
		row, ok := byKey[key]
		if !ok {
			continue
		}
		f := Field{
			Value:        decodeValue(row.Value),
			Origin:       row.Origin,
			OriginDetail: row.OriginDetail,
			Description:  descriptions[key],
		}
		f.Preset = presetOf(row.OriginDetail)
		if row.Origin == originEnv && f.Preset == "" {
			f.SystemValue = c.systemValue(ctx, key)
		}
		doc.Fields[key] = f
	}

	for _, rd := range Roles {
		role := buildRole(rd, byKey, c.writeToolLeaf)
		for key, cell := range map[string]*Cell{
			roleToolKey(byKey, rd.Name, c.writeToolLeaf):         &role.Tool,
			profileKeyPrefix + rd.Name + "." + profileLeafModel:  &role.Model,
			profileKeyPrefix + rd.Name + "." + profileLeafEffort: &role.Effort,
		} {
			if cell.Origin != originEnv || cell.Preset != "" {
				continue
			}
			if v := c.systemValue(ctx, key); v != nil {
				s := fmt.Sprint(v)
				cell.SystemValue = &s
			}
		}
		doc.Roles = append(doc.Roles, role)
	}
	return doc, nil
}

func indexRows(rows []showRow) map[string]showRow {
	byKey := make(map[string]showRow, len(rows))
	for _, r := range rows {
		byKey[r.Key] = r
	}
	return byKey
}

// probeToolLeaf picks the role tool leaf the installed fab writes: "cli" once
// fab shows any new-spelling key (a renamed fab emits clis.<name>.* defaults
// for its built-in tools) or explains one, else today's "provider". It reuses
// output already fetched, so the probe costs no extra fab call.
func probeToolLeaf(rows []showRow, explained map[string]string) string {
	for _, r := range rows {
		if isNewSpellingKey(r.Key) {
			return profileLeafCLI
		}
	}
	for key := range explained {
		if isNewSpellingKey(key) {
			return profileLeafCLI
		}
	}
	return profileLeafProvider
}

func isNewSpellingKey(key string) bool {
	if key == clisTableKey || strings.HasPrefix(key, clisKeyPrefix) {
		return true
	}
	rest, ok := strings.CutPrefix(key, profileKeyPrefix)
	if !ok {
		return false
	}
	_, leaf, _ := strings.Cut(rest, ".")
	return leaf == profileLeafCLI
}

func (c *Client) systemPath(rows []showRow) string {
	for _, r := range rows {
		if r.Origin == originSystem && r.OriginDetail != "" {
			return r.OriginDetail
		}
	}
	if home, err := c.home(); err == nil {
		return filepath.Join(home, systemConfigRelPath)
	}
	return "~/" + systemConfigRelPath
}

// descriptions is best-effort: a failing `explain` only costs the sublabels.
func (c *Client) descriptions(ctx context.Context) map[string]string {
	out, err := c.fab(ctx, "config", "explain", "--json")
	if err != nil {
		return nil
	}
	var rows []explainRow
	if json.Unmarshal(out, &rows) != nil {
		return nil
	}
	m := make(map[string]string, len(rows))
	for _, r := range rows {
		m[r.Key] = r.Description
	}
	return m
}

// systemValue returns the system-tier value hidden behind an env winner, or
// nil when none exists (or the stack read fails — it is display-only).
func (c *Client) systemValue(ctx context.Context, key string) any {
	out, err := c.fab(ctx, "config", "show", key, "--origin", "--json")
	if err != nil {
		return nil
	}
	var stack []showRow
	if json.Unmarshal(out, &stack) != nil {
		return nil
	}
	for _, r := range stack {
		if r.Origin == originSystem {
			return decodeValue(r.Value)
		}
	}
	return nil
}

// modelSuggestions is the fallback list: the distinct fill values of the
// tool's profiles, sorted, with no label, efforts or default.
func modelSuggestions(rows []showRow, tool string) []ModelSuggestion {
	seen := map[string]struct{}{}
	var ids []string
	for _, r := range rows {
		if !hasToolProfilePrefix(r.Key, tool) || !strings.HasSuffix(r.Key, "."+profileLeafModel) {
			continue
		}
		if v := valueString(r.Value); v != "" {
			if _, dup := seen[v]; !dup {
				seen[v] = struct{}{}
				ids = append(ids, v)
			}
		}
	}
	sort.Strings(ids)
	out := make([]ModelSuggestion, 0, len(ids))
	for _, id := range ids {
		out = append(out, ModelSuggestion{ID: id})
	}
	return out
}

// discovery is the outcome of one `fab agent models --json` call; ok is false
// when it failed for any reason (an older fab without the verb is the expected
// one, so a failure is silent).
type discovery struct {
	rows     []modelRow
	warnings []string
	ok       bool
}

func (c *Client) discoverModels(ctx context.Context) discovery {
	stdout, stderr, err := c.run(ctx, "agent", "models", "--json")
	if err != nil {
		return discovery{}
	}
	var rows []modelRow
	// A JSON null decodes without error; it carries no rows, so fall back too.
	if json.Unmarshal(stdout, &rows) != nil || rows == nil {
		return discovery{}
	}
	return discovery{rows: rows, warnings: warningLines(stderr), ok: true}
}

// presetList is the outcome of one `fab agent presets --json` call; ok is
// false when it failed for any reason (a fab without the verb is the expected
// one, so a failure is silent).
type presetList struct {
	presets  []AgentPreset
	warnings []string
	ok       bool
}

func (c *Client) listPresets(ctx context.Context) presetList {
	stdout, stderr, err := c.run(ctx, presetsArgv...)
	if err != nil {
		return presetList{}
	}
	presets, ok := decodePresets(stdout)
	if !ok {
		return presetList{}
	}
	return presetList{presets: presets, warnings: warningLines(stderr), ok: true}
}

// presetsArgv is the fab invocation behind every preset list read.
var presetsArgv = []string{"agent", "presets", "--json"}

// decodePresets decodes `fab agent presets --json` output. A JSON null
// decodes without error but is not a list, so it reports !ok like malformed
// output.
func decodePresets(stdout []byte) ([]AgentPreset, bool) {
	var presets []AgentPreset
	if json.Unmarshal(stdout, &presets) != nil || presets == nil {
		return nil, false
	}
	return presets, true
}

// ErrPresetsUnsupported reports a fab that cannot list agent presets (one
// that predates the verb, or a failed/timed-out call).
var ErrPresetsUnsupported = errors.New("agent presets are not supported by the installed fab")

// ListAgentPresets runs `fab agent presets --json` with dir as the working
// directory, so project-defined presets resolve for that repo; the machine-wide
// view passes $HOME. Any failure (fab absent or older, timeout, non-array
// output) returns ErrPresetsUnsupported.
func ListAgentPresets(ctx context.Context, dir string) ([]AgentPreset, error) {
	stdout, err := runPresetsIn(ctx, dir)
	if err != nil {
		return nil, ErrPresetsUnsupported
	}
	presets, ok := decodePresets(stdout)
	if !ok {
		return nil, ErrPresetsUnsupported
	}
	return presets, nil
}

// runPresetsIn is the exec seam behind ListAgentPresets (a var for tests).
var runPresetsIn = func(ctx context.Context, dir string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, FabTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, "fab", presetsArgv...)
	cmd.Dir = dir
	var stdout bytes.Buffer
	cmd.Stdout = &stdout
	if err := cmd.Run(); err != nil {
		return nil, err
	}
	return stdout.Bytes(), nil
}

// PresetNone is fab's reserved "no preset here, even if a lower layer chose
// one"; it is never listed but accepted wherever a preset name is.
const PresetNone = presetNone

// CheckPresetMember accepts a name fab lists, or the reserved PresetNone.
func CheckPresetMember(name string, presets []AgentPreset) error {
	names := namesOf(presets)
	if name != PresetNone && !contains(names, name) {
		return fmt.Errorf("unknown agent preset %q (available: %s)", name, strings.Join(names, ", "))
	}
	return nil
}

func namesOf(presets []AgentPreset) []string {
	names := make([]string, 0, len(presets))
	for _, p := range presets {
		names = append(names, p.Name)
	}
	return names
}

// presetOf is the preset name an origin_detail of "preset <name>" carries,
// else "".
func presetOf(originDetail string) string {
	name, _ := strings.CutPrefix(originDetail, presetOriginPrefix)
	if name == originDetail {
		return ""
	}
	return name
}

// appendUnique appends the lines of extra that dst does not already hold: fab
// repeats a config-level warning on every call it makes.
func appendUnique(dst, extra []string) []string {
	for _, line := range extra {
		if !contains(dst, line) {
			dst = append(dst, line)
		}
	}
	return dst
}

// discoveredSuggestions keys fab's rows by tool in fab's order. Only tools in
// tools are kept, each with an entry; reserved rows, empty ids and repeated
// ids (first wins) are dropped.
func discoveredSuggestions(rows []modelRow, tools []string) map[string][]ModelSuggestion {
	out := make(map[string][]ModelSuggestion, len(tools))
	seen := make(map[string]map[string]struct{}, len(tools))
	for _, t := range tools {
		out[t] = []ModelSuggestion{}
		seen[t] = map[string]struct{}{}
	}
	for _, r := range rows {
		tool := r.tool()
		ids, known := seen[tool]
		if !known || r.Source == sourceReserved || r.ID == "" {
			continue
		}
		if _, dup := ids[r.ID]; dup {
			continue
		}
		ids[r.ID] = struct{}{}
		out[tool] = append(out[tool], r.suggestion())
	}
	return out
}

// discoveredToolDefaults keys each listed tool's first reserved row with an id.
func discoveredToolDefaults(rows []modelRow, tools []string) map[string]ModelSuggestion {
	out := map[string]ModelSuggestion{}
	for _, r := range rows {
		tool := r.tool()
		if r.Source != sourceReserved || r.ID == "" || !contains(tools, tool) {
			continue
		}
		if _, dup := out[tool]; !dup {
			out[tool] = r.suggestion()
		}
	}
	return out
}

func hasToolProfilePrefix(key, tool string) bool {
	for _, prefix := range toolTablePrefixes {
		if strings.HasPrefix(key, prefix+tool+toolProfileInfix) {
			return true
		}
	}
	return false
}

// tableKey is the first spelling of <table>.<tool><suffix> that fab shows,
// else "".
func tableKey(byKey map[string]showRow, tool, suffix string) string {
	for _, prefix := range toolTablePrefixes {
		if key := prefix + tool + suffix; hasRow(byKey, key) {
			return key
		}
	}
	return ""
}

func hasRow(byKey map[string]showRow, key string) bool {
	_, ok := byKey[key]
	return ok
}

// effortCapable reports whether either of the tool's commands takes an
// effort; a tool with neither command takes none.
func effortCapable(byKey map[string]showRow, tool string) bool {
	for _, leaf := range []string{interactiveCmdLeaf, headlessCmdLeaf} {
		if strings.Contains(valueString(byKey[tableKey(byKey, tool, leaf)].Value), effortToken) {
			return true
		}
	}
	return false
}

// roleToolKey is the row key a role's tool is read from: the first spelling
// fab shows, else agent.profiles.<role>.<fallbackLeaf> (absent — no override).
func roleToolKey(byKey map[string]showRow, role, fallbackLeaf string) string {
	for _, leaf := range toolLeafSpellings {
		if key := profileKeyPrefix + role + "." + leaf; hasRow(byKey, key) {
			return key
		}
	}
	return profileKeyPrefix + role + "." + fallbackLeaf
}

// depthKey is the knob a role's tool inherits from.
func depthKey(depth string) string {
	if depth == depthSession {
		return KeyAgentSession
	}
	return KeyAgentWorkers
}

func buildRole(rd roleDef, byKey map[string]showRow, toolLeaf string) Role {
	role := Role{Role: rd.Name, Depth: rd.Depth}
	tool := cellFor(byKey, roleToolKey(byKey, rd.Name, toolLeaf), "")
	tool.Inherited = valueString(byKey[depthKey(rd.Depth)].Value)
	role.Tool = tool
	for _, leaf := range []string{profileLeafModel, profileLeafEffort} {
		fallback := fillKey(byKey, tool.Effective, rd.Name, leaf)
		cell := cellFor(byKey, profileKeyPrefix+rd.Name+"."+leaf, fallback)
		cell.Inherited = valueString(byKey[fallback].Value)
		if leaf == profileLeafModel {
			role.Model = cell
		} else {
			role.Effort = cell
		}
	}
	return role
}

// fillKey is the tool-table key an unset role leaf inherits: the tool's
// non-empty fill for this role, else its non-empty default-profile fill, else
// "" (the tool's own default applies) — fab skips empty fills too.
func fillKey(byKey map[string]showRow, tool, role, leaf string) string {
	for _, profile := range []string{role, defaultProfile} {
		for _, prefix := range toolTablePrefixes {
			key := prefix + tool + toolProfileInfix + profile + "." + leaf
			if r, ok := byKey[key]; ok && valueString(r.Value) != "" {
				return key
			}
		}
	}
	return ""
}

// cellFor reads one role leaf. A present row wins; otherwise fallbackKey (the
// tool table's value) supplies the inherited display, and a missing
// fallback leaves Effective empty ("tool default" in the UI).
func cellFor(byKey map[string]showRow, key, fallbackKey string) Cell {
	row, ok := byKey[key]
	if !ok {
		if fb, ok := byKey[fallbackKey]; ok && fallbackKey != "" {
			return Cell{Effective: valueString(fb.Value), Source: fallbackKey, Origin: fb.Origin, OriginDetail: fb.OriginDetail, Preset: presetOf(fb.OriginDetail)}
		}
		return Cell{Source: ""}
	}
	val := valueString(row.Value)
	cell := Cell{Effective: val, Source: key, Origin: row.Origin, OriginDetail: row.OriginDetail, Preset: presetOf(row.OriginDetail)}
	if row.DerivedFrom != nil && row.DerivedFrom.Key != "" {
		cell.Source = row.DerivedFrom.Key
	}
	if row.Origin == originSystem && cell.Preset == "" {
		cell.Override = &val
	}
	return cell
}

// ---- writes ----

// isProfileKey reports whether key is agent.profiles.<role>.<leaf> for one of
// Roles and profileLeaves, so a role added to Roles is writable without a
// second list to keep in sync.
func isProfileKey(key string) bool {
	rest, ok := strings.CutPrefix(key, profileKeyPrefix)
	if !ok {
		return false
	}
	role, leaf, ok := strings.Cut(rest, ".")
	if !ok || !contains(profileLeaves, leaf) {
		return false
	}
	for _, rd := range Roles {
		if rd.Name == role {
			return true
		}
	}
	return false
}

func isScalarKey(key string) bool {
	for _, k := range ScalarKeys {
		if k == key {
			return true
		}
	}
	return false
}

// op is one validated write: unset when value is nil.
type op struct {
	key   string
	value *string
}

func (o op) argv() []string {
	if o.value == nil {
		return []string{"config", "unset", o.key, "--system"}
	}
	return []string{"config", "set", o.key, *o.value, "--system"}
}

// validate turns a raw patch into ops sorted by the key fab will write, or a
// ValidationError. Nothing is exec'd here. tools is the effective tool set;
// toolLeaf is the installed fab's spelling every role tool leaf is written as;
// presets is fab's current preset list, consulted for an agent.preset set and
// for every agent_presets.* key.
func validate(patch map[string]json.RawMessage, tools []string, toolLeaf string, presets presetList) ([]op, error) {
	keys := make([]string, 0, len(patch))
	for k := range patch {
		keys = append(keys, k)
	}
	sort.Strings(keys)

	ops := make([]op, 0, len(keys))
	writeKeys := map[string]string{}
	for _, key := range keys {
		raw := patch[key]
		if strings.HasPrefix(key, presetsKeyPrefix) {
			o, err := validatePresetKey(key, raw, tools, presets)
			if err != nil {
				return nil, &ValidationError{Msg: key + ": " + err.Error()}
			}
			ops = append(ops, o)
			continue
		}
		if !isScalarKey(key) && !isProfileKey(key) {
			return nil, &ValidationError{Msg: "unknown key: " + key}
		}
		target := writeKey(key, toolLeaf)
		if prev, dup := writeKeys[target]; dup {
			return nil, &ValidationError{Msg: key + ": same setting as " + prev}
		}
		writeKeys[target] = key
		if string(bytes.TrimSpace(raw)) == "null" {
			ops = append(ops, op{key: target})
			continue
		}
		val, err := validateValue(key, raw, tools, presets)
		if err != nil {
			return nil, &ValidationError{Msg: key + ": " + err.Error()}
		}
		if val == nil { // empty profile leaf == unset
			ops = append(ops, op{key: target})
			continue
		}
		ops = append(ops, op{key: target, value: val})
	}
	sort.Slice(ops, func(i, j int) bool { return ops[i].key < ops[j].key })
	if err := checkPresetOps(ops, presets); err != nil {
		return nil, err
	}
	return ops, nil
}

// writeKey maps any accepted spelling of a role's tool leaf to toolLeaf; every
// other key is written as given.
func writeKey(key, toolLeaf string) string {
	if !isToolKey(key) || !strings.HasPrefix(key, profileKeyPrefix) {
		return key
	}
	return key[:strings.LastIndex(key, ".")+1] + toolLeaf
}

func validateValue(key string, raw json.RawMessage, tools []string, presets presetList) (*string, error) {
	switch key {
	case KeyDispatchReapDone:
		var b bool
		if err := json.Unmarshal(raw, &b); err != nil {
			return nil, errors.New("must be a boolean")
		}
		return ptr(strconv.FormatBool(b)), nil
	case KeyDispatchColWidth:
		n, err := intValue(raw)
		if err != nil || n < 1 || n > maxColumnWidth {
			return nil, fmt.Errorf("must be an integer from 1 to %d", maxColumnWidth)
		}
		return ptr(strconv.Itoa(n)), nil
	case KeyDispatchMinCols, KeyDispatchMinRows:
		n, err := intValue(raw)
		if err != nil || n < 1 {
			return nil, errors.New("must be a positive integer")
		}
		return ptr(strconv.Itoa(n)), nil
	}

	var s string
	if err := json.Unmarshal(raw, &s); err != nil {
		return nil, errors.New("must be a string")
	}
	s = strings.TrimSpace(s)

	if key == KeyAgentPreset {
		return validatePreset(s, presets)
	}
	if key == KeyDispatchMode {
		if !contains(DispatchModes, s) {
			return nil, fmt.Errorf("must be one of %s", strings.Join(DispatchModes, ", "))
		}
		return &s, nil
	}

	isProfile := isProfileKey(key)
	if s == "" && isProfile {
		return nil, nil
	}
	if isToolKey(key) {
		if !contains(tools, s) {
			return nil, fmt.Errorf("unknown CLI %q (available: %s)", s, strings.Join(tools, ", "))
		}
		return &s, nil
	}
	// agent.profiles.<role>.{model,effort}
	if err := checkFreeText(s); err != nil {
		return nil, err
	}
	return &s, nil
}

// validatePreset accepts a preset fab lists, or its reserved "none". Without a
// readable list (a fab that predates presets) nothing can be set.
func validatePreset(name string, presets presetList) (*string, error) {
	if err := checkFreeText(name); err != nil {
		return nil, err
	}
	if !presets.ok {
		return nil, ErrPresetsUnsupported
	}
	if err := CheckPresetMember(name, presets.presets); err != nil {
		return nil, err
	}
	return &name, nil
}

// patchNeedsPresets reports whether validating the patch needs fab's preset
// list: it sets (not unsets) agent.preset or touches a preset definition.
func patchNeedsPresets(patch map[string]json.RawMessage) bool {
	if raw, ok := patch[KeyAgentPreset]; ok && string(bytes.TrimSpace(raw)) != "null" {
		return true
	}
	for key := range patch {
		if strings.HasPrefix(key, presetsKeyPrefix) {
			return true
		}
	}
	return false
}

// isToolKey reports whether key names a tool: a depth knob or any accepted
// spelling of a role's tool leaf.
func isToolKey(key string) bool {
	if key == KeyAgentSession || key == KeyAgentWorkers {
		return true
	}
	if !strings.HasPrefix(key, profileKeyPrefix) {
		return false
	}
	return contains(toolLeaves, key[strings.LastIndex(key, ".")+1:])
}

// checkFreeText guards model/effort: single-line, non-empty, no YAML comment
// marker, no leading dash (it would parse as a flag), bounded length.
func checkFreeText(s string) error {
	switch {
	case s == "":
		return errors.New("must not be empty")
	case len(s) > maxProfileValueLen:
		return fmt.Errorf("must be at most %d characters", maxProfileValueLen)
	case strings.HasPrefix(s, "-"):
		return errors.New("must not start with '-'")
	case strings.Contains(s, "#"):
		return errors.New("must not contain '#'")
	}
	for _, r := range s {
		if unicode.IsControl(r) {
			return errors.New("must be a single line")
		}
	}
	return nil
}

func intValue(raw json.RawMessage) (int, error) {
	var f float64
	if err := json.Unmarshal(raw, &f); err != nil {
		return 0, err
	}
	n := int(f)
	if float64(n) != f {
		return 0, errors.New("not an integer")
	}
	return n, nil
}

func contains(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}

func ptr(s string) *string { return &s }

// applyMu serializes Apply across requests (the API builds a Client per
// request): fab's set/unset rewrite the whole system file without a lock, so
// two overlapping patches could each succeed and lose the other's keys.
var applyMu sync.Mutex

// Apply validates the whole patch, then runs the set/unset calls sequentially
// (sorted by written key) and returns a freshly read document whose Warnings carry
// the write calls' stderr warning lines followed by the re-read's discovery
// warnings. It stops at the first failing fab call — earlier
// writes in the same patch are already durable (fab has no multi-key
// transaction).
func (c *Client) Apply(ctx context.Context, patch map[string]json.RawMessage) (*Document, error) {
	if !c.installed() {
		return nil, ErrNotInstalled
	}
	warnings, err := c.write(ctx, patch)
	if err != nil {
		return nil, err
	}
	// The re-read runs outside applyMu: it writes nothing, and its model
	// discovery can take seconds that a concurrent patch should not wait on.
	doc, err := c.Read(ctx)
	if err != nil {
		return nil, err
	}
	doc.Warnings = append(warnings, doc.Warnings...)
	return doc, nil
}

// write validates the patch and runs its set/unset calls under applyMu,
// returning their warning lines.
func (c *Client) write(ctx context.Context, patch map[string]json.RawMessage) ([]string, error) {
	applyMu.Lock()
	defer applyMu.Unlock()
	rows, err := c.loadRows(ctx)
	if err != nil {
		return nil, err
	}
	c.writeToolLeaf = probeToolLeaf(rows, nil)
	// The list is fetched here, under applyMu and before any write, so a
	// preset another process removed since the SPA's read is rejected up front.
	var presets presetList
	if patchNeedsPresets(patch) {
		presets = c.listPresets(ctx)
	}
	ops, err := validate(patch, toolNames(rows), c.writeToolLeaf, presets)
	if err != nil {
		return nil, err
	}

	var warnings []string
	for _, o := range ops {
		argv := o.argv()
		_, stderr, runErr := c.run(ctx, argv...)
		if runErr != nil {
			return nil, &CommandError{Argv: argv, Stderr: strings.TrimSpace(string(stderr))}
		}
		warnings = append(warnings, warningLines(stderr)...)
	}
	return warnings, nil
}

func warningLines(stderr []byte) []string {
	var out []string
	for _, line := range strings.Split(string(stderr), "\n") {
		line = strings.TrimSpace(line)
		if line != "" && strings.Contains(strings.ToLower(line), warningMarker) {
			out = append(out, line)
		}
	}
	return out
}
