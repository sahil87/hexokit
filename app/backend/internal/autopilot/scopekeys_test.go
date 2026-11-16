package autopilot

import (
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"strconv"
	"strings"
	"testing"

	"rk/internal/operator"
)

// parsePackageSources parses the package's non-test files.
func parsePackageSources(t *testing.T) []*ast.File {
	t.Helper()
	fset := token.NewFileSet()
	pkgs, err := parser.ParseDir(fset, ".", func(fi fs.FileInfo) bool {
		return !strings.HasSuffix(fi.Name(), "_test.go")
	}, 0)
	if err != nil {
		t.Fatal(err)
	}
	var files []*ast.File
	for _, pkg := range pkgs {
		for _, f := range pkg.Files {
			files = append(files, f)
		}
	}
	if len(files) == 0 {
		t.Fatal("no source files parsed")
	}
	return files
}

func stringLit(e ast.Expr) (string, bool) {
	lit, ok := e.(*ast.BasicLit)
	if !ok || lit.Kind != token.STRING {
		return "", false
	}
	v, err := strconv.Unquote(lit.Value)
	return v, err == nil
}

// The engine's scope keys are defined once, in internal/operator, which refuses
// hand writes to them. A key the engine writes that operator does not register
// would be writable through track update, so this fails until it is.
func TestEngineWritesOnlyRegisteredScopeKeys(t *testing.T) {
	for _, f := range parsePackageSources(t) {
		probeFields := probeFieldLiterals(f)
		ast.Inspect(f, func(n ast.Node) bool {
			switch x := n.(type) {
			case *ast.GenDecl:
				// scope* constants: values must come from operator, never a
				// second literal list.
				for _, spec := range x.Specs {
					vs, ok := spec.(*ast.ValueSpec)
					if !ok {
						continue
					}
					for i, name := range vs.Names {
						if !strings.HasPrefix(name.Name, "scope") || i >= len(vs.Values) {
							continue
						}
						if lit, isLit := stringLit(vs.Values[i]); isLit {
							t.Errorf("%s is the literal %q: define the key once in internal/operator/ownership.go and alias it", name.Name, lit)
						}
					}
				}
			case *ast.IndexExpr:
				if !isScopeMap(x.X) {
					return true
				}
				if key, ok := stringLit(x.Index); ok && !operator.EngineMayWrite(key) {
					t.Errorf("scope key %q is written by the engine but not registered for it in internal/operator/ownership.go", key)
				}
			case *ast.CompositeLit:
				if !isScopeLiteral(x) || probeFields[x] {
					return true
				}
				for _, el := range x.Elts {
					kv, ok := el.(*ast.KeyValueExpr)
					if !ok {
						continue
					}
					if key, ok := stringLit(kv.Key); ok && !operator.EngineMayWrite(key) {
						t.Errorf("scope key %q is written by the engine but not registered for it in internal/operator/ownership.go", key)
					}
				}
			}
			return true
		})
	}
}

// isScopeMap matches the `<x>.Scope` selector and a local `scope` variable.
func isScopeMap(e ast.Expr) bool {
	switch x := e.(type) {
	case *ast.SelectorExpr:
		return x.Sel.Name == "Scope"
	case *ast.Ident:
		return x.Name == "scope"
	}
	return false
}

// isScopeLiteral matches every map[string]... literal in the engine: the only
// such literal that is not a scope is a probe observation's Fields value, which
// the caller exempts. Matching by type rather than by known keys means a map
// holding only an unregistered key is still checked.
func isScopeLiteral(lit *ast.CompositeLit) bool {
	mt, ok := lit.Type.(*ast.MapType)
	if !ok {
		return false
	}
	k, ok := mt.Key.(*ast.Ident)
	return ok && k.Name == "string"
}

// probeFieldLiterals returns the map literals given as a probe observation's
// Fields, which hold probe output keys rather than scope keys.
func probeFieldLiterals(f *ast.File) map[*ast.CompositeLit]bool {
	out := map[*ast.CompositeLit]bool{}
	ast.Inspect(f, func(n ast.Node) bool {
		kv, ok := n.(*ast.KeyValueExpr)
		if !ok {
			return true
		}
		if id, ok := kv.Key.(*ast.Ident); ok && id.Name == "Fields" {
			if lit, ok := kv.Value.(*ast.CompositeLit); ok {
				out[lit] = true
			}
		}
		return true
	})
	return out
}

// Every scope* constant in the package resolves to a registered key, and every
// engine-owned key has one: adding an engine key to the registry without using
// it, or using one without registering it, fails here.
func TestScopeConstantsMatchTheEngineOwnedSet(t *testing.T) {
	used := map[string]bool{
		scopeRespawned: true, scopeSkipped: true, scopeSpawning: true, scopeMergeSeq: true,
		scopeItem: true, scopeArmed: true, scopeHalted: true, scopeDirect: true,
		scopeStallSeen: true, scopeDeferred: true, scopeQueue: true, scopeEscalated: true,
		scopeMergeMode: true, scopeURL: true,
	}
	for _, k := range operator.EngineScopeKeys() {
		if !used[k] {
			t.Errorf("engine-owned key %q has no scope constant in this package", k)
		}
	}
	for k := range used {
		if !operator.EngineMayWrite(k) {
			t.Errorf("scope constant value %q is not registered for the engine", k)
		}
	}
	if scopeTask != "task" || scopeBare != "bare" {
		t.Error("task/bare identity keys drifted")
	}
}

// A queue run end to end leaves only registered scope keys on every item, and
// the engine's own writes to its keys survive track update's refusals.
func TestFullPassLeavesOnlyRegisteredScopeKeys(t *testing.T) {
	h := newHarness(t)
	foo := newRepo(t, "foo")
	h.queue("", Entry{ID: "a", Repo: foo.Dir, Task: "a"})
	h.step()
	h.shipped(1, "a")
	h.startMerge()
	h.step()
	for _, it := range h.state().Tracked {
		for k := range it.Scope {
			if !operator.ScopeKeyKnown(k) {
				t.Errorf("%s carries unregistered scope key %q", it.ID, k)
			}
		}
	}
}

// A literal holding only an unregistered key is still a scope literal.
func TestScopeLiteralMatchesUnregisteredOnlyMap(t *testing.T) {
	f, err := parser.ParseFile(token.NewFileSet(), "x.go", `package x
var _ = map[string]interface{}{"new_engine_flag": true}
var _ = struct{ Fields map[string]interface{} }{Fields: map[string]interface{}{"state": 1}}
`, 0)
	if err != nil {
		t.Fatal(err)
	}
	probe := probeFieldLiterals(f)
	var scopes, exempt int
	ast.Inspect(f, func(n ast.Node) bool {
		if lit, ok := n.(*ast.CompositeLit); ok && isScopeLiteral(lit) {
			if probe[lit] {
				exempt++
			} else {
				scopes++
			}
		}
		return true
	})
	if scopes != 1 || exempt != 1 {
		t.Fatalf("scope literals = %d, exempt probe fields = %d; want 1 and 1", scopes, exempt)
	}
}
