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
//
// Writes validate the patch in full first (§I — fab itself rejects most bad
// values but the daemon must not rely on it for subprocess input), then run
// `fab config set|unset <key> [<value>] --system` sequentially.
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
	KeyAgentSession      = "agent.session"
	KeyAgentWorkers      = "agent.workers"
	KeyDispatchMode      = "dispatch.mode"
	KeyDispatchColWidth  = "dispatch.column_width"
	KeyDispatchMinCols   = "dispatch.min_cols"
	KeyDispatchMinRows   = "dispatch.min_rows"
	KeyDispatchReapDone  = "dispatch.reap_done"
	profileKeyPrefix     = "agent.profiles."
	providersKeyPrefix   = "providers."
	systemConfigRelPath  = ".fab-kit/config.yaml"
	originEnv            = "env"
	originSystem         = "system"
	depthSession         = "session"
	depthWorkers         = "workers"
	maxProfileValueLen   = 128
	maxColumnWidth       = 99
	warningMarker        = "warning"
	profileLeafProvider  = "provider"
	profileLeafModel     = "model"
	profileLeafEffort    = "effort"
	providerProfileInfix = ".profiles."
)

// ScalarKeys are the v1 non-profile keys, in display order.
var ScalarKeys = []string{
	KeyAgentSession, KeyAgentWorkers,
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

var profileLeaves = []string{profileLeafProvider, profileLeafModel, profileLeafEffort}

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
}

// Cell is one role leaf (provider, model or effort).
type Cell struct {
	// Override is set only when the leaf's origin is the system tier.
	Override     *string `json:"override"`
	Effective    string  `json:"effective"`
	Source       string  `json:"source"`
	Origin       string  `json:"origin"`
	OriginDetail string  `json:"originDetail,omitempty"`
	// Inherited is what the leaf resolves to with no override: the depth knob
	// for provider, the resolved provider's profile fill for model/effort.
	Inherited string `json:"inherited"`
	// SystemValue is the system-tier value shadowed by an env winner.
	SystemValue *string `json:"systemValue,omitempty"`
}

// Role is one row of the per-role override table.
type Role struct {
	Role     string `json:"role"`
	Depth    string `json:"depth"`
	Provider Cell   `json:"provider"`
	Model    Cell   `json:"model"`
	Effort   Cell   `json:"effort"`
}

// Document is the GET /api/fab-config payload.
type Document struct {
	Installed         bool                `json:"installed"`
	SystemPath        string              `json:"systemPath,omitempty"`
	Providers         []string            `json:"providers,omitempty"`
	Fields            map[string]Field    `json:"fields,omitempty"`
	Roles             []Role              `json:"roles,omitempty"`
	ModelSuggestions  map[string][]string `json:"modelSuggestions,omitempty"`
	EffortSuggestions []string            `json:"effortSuggestions,omitempty"`
	Warnings          []string            `json:"warnings,omitempty"`
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

// providerNames derives the provider set from the providers.<name>.* leaves —
// never a hard-coded list, so a kit that ships a new provider appears at once.
func providerNames(rows []showRow) []string {
	seen := map[string]struct{}{}
	for _, r := range rows {
		rest, ok := strings.CutPrefix(r.Key, providersKeyPrefix)
		if !ok {
			continue
		}
		if name, _, found := strings.Cut(rest, "."); found && name != "" {
			seen[name] = struct{}{}
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
	rows, err := c.loadRows(ctx)
	if err != nil {
		return nil, err
	}
	byKey := make(map[string]showRow, len(rows))
	for _, r := range rows {
		byKey[r.Key] = r
	}

	doc := &Document{
		Installed:         true,
		SystemPath:        c.systemPath(rows),
		Providers:         providerNames(rows),
		Fields:            map[string]Field{},
		ModelSuggestions:  map[string][]string{},
		EffortSuggestions: EffortSuggestions,
	}
	for _, p := range doc.Providers {
		doc.ModelSuggestions[p] = modelSuggestions(rows, p)
	}

	descriptions := c.descriptions(ctx)
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
		if row.Origin == originEnv {
			f.SystemValue = c.systemValue(ctx, key)
		}
		doc.Fields[key] = f
	}

	for _, rd := range Roles {
		role := buildRole(rd, byKey)
		for leaf, cell := range map[string]*Cell{
			profileLeafProvider: &role.Provider, profileLeafModel: &role.Model, profileLeafEffort: &role.Effort,
		} {
			if cell.Origin != originEnv {
				continue
			}
			if v := c.systemValue(ctx, profileKeyPrefix+rd.Name+"."+leaf); v != nil {
				s := fmt.Sprint(v)
				cell.SystemValue = &s
			}
		}
		doc.Roles = append(doc.Roles, role)
	}
	return doc, nil
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

func modelSuggestions(rows []showRow, provider string) []string {
	prefix := providersKeyPrefix + provider + providerProfileInfix
	seen := map[string]struct{}{}
	var out []string
	for _, r := range rows {
		if !strings.HasPrefix(r.Key, prefix) || !strings.HasSuffix(r.Key, "."+profileLeafModel) {
			continue
		}
		if v := valueString(r.Value); v != "" {
			if _, dup := seen[v]; !dup {
				seen[v] = struct{}{}
				out = append(out, v)
			}
		}
	}
	sort.Strings(out)
	if out == nil {
		out = []string{}
	}
	return out
}

// depthKey is the knob a role's provider inherits from.
func depthKey(depth string) string {
	if depth == depthSession {
		return KeyAgentSession
	}
	return KeyAgentWorkers
}

func buildRole(rd roleDef, byKey map[string]showRow) Role {
	role := Role{Role: rd.Name, Depth: rd.Depth}
	provider := cellFor(byKey, profileKeyPrefix+rd.Name+"."+profileLeafProvider, "")
	provider.Inherited = valueString(byKey[depthKey(rd.Depth)].Value)
	role.Provider = provider
	for _, leaf := range []string{profileLeafModel, profileLeafEffort} {
		// An unset leaf inherits the resolved provider's profile for this role.
		fallback := providersKeyPrefix + provider.Effective + providerProfileInfix + rd.Name + "." + leaf
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

// cellFor reads one role leaf. A present row wins; otherwise fallbackKey (the
// provider table's value) supplies the inherited display, and a missing
// fallback leaves Effective empty ("provider default" in the UI).
func cellFor(byKey map[string]showRow, key, fallbackKey string) Cell {
	row, ok := byKey[key]
	if !ok {
		if fb, ok := byKey[fallbackKey]; ok && fallbackKey != "" {
			return Cell{Effective: valueString(fb.Value), Source: fallbackKey, Origin: fb.Origin, OriginDetail: fb.OriginDetail}
		}
		return Cell{Source: ""}
	}
	val := valueString(row.Value)
	cell := Cell{Effective: val, Source: key, Origin: row.Origin, OriginDetail: row.OriginDetail}
	if row.DerivedFrom != nil && row.DerivedFrom.Key != "" {
		cell.Source = row.DerivedFrom.Key
	}
	if row.Origin == originSystem {
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

// validate turns a raw patch into ordered ops, or a ValidationError. Nothing
// is exec'd here. providers is the effective providers set.
func validate(patch map[string]json.RawMessage, providers []string) ([]op, error) {
	keys := make([]string, 0, len(patch))
	for k := range patch {
		keys = append(keys, k)
	}
	sort.Strings(keys)

	ops := make([]op, 0, len(keys))
	for _, key := range keys {
		raw := patch[key]
		if !isScalarKey(key) && !isProfileKey(key) {
			return nil, &ValidationError{Msg: "unknown key: " + key}
		}
		if string(bytes.TrimSpace(raw)) == "null" {
			ops = append(ops, op{key: key})
			continue
		}
		val, err := validateValue(key, raw, providers)
		if err != nil {
			return nil, &ValidationError{Msg: key + ": " + err.Error()}
		}
		if val == nil { // empty profile leaf == unset
			ops = append(ops, op{key: key})
			continue
		}
		ops = append(ops, op{key: key, value: val})
	}
	return ops, nil
}

func validateValue(key string, raw json.RawMessage, providers []string) (*string, error) {
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
	if isProviderKey(key) {
		if !contains(providers, s) {
			return nil, fmt.Errorf("unknown provider %q (available: %s)", s, strings.Join(providers, ", "))
		}
		return &s, nil
	}
	// agent.profiles.<role>.{model,effort}
	if err := checkFreeText(s); err != nil {
		return nil, err
	}
	return &s, nil
}

func isProviderKey(key string) bool {
	if key == KeyAgentSession || key == KeyAgentWorkers {
		return true
	}
	return strings.HasSuffix(key, "."+profileLeafProvider) && strings.HasPrefix(key, profileKeyPrefix)
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
// (sorted key order) and returns a freshly read document whose Warnings carry
// fab's stderr warning lines. It stops at the first failing fab call — earlier
// writes in the same patch are already durable (fab has no multi-key
// transaction).
func (c *Client) Apply(ctx context.Context, patch map[string]json.RawMessage) (*Document, error) {
	if !c.installed() {
		return nil, ErrNotInstalled
	}
	applyMu.Lock()
	defer applyMu.Unlock()
	rows, err := c.loadRows(ctx)
	if err != nil {
		return nil, err
	}
	ops, err := validate(patch, providerNames(rows))
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

	doc, err := c.Read(ctx)
	if err != nil {
		return nil, err
	}
	doc.Warnings = warnings
	return doc, nil
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
