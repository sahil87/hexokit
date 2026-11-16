package operator

// Identity and free-form scope keys.
const (
	ScopeTask = "task"
	ScopeBare = "bare"
	// ScopeMemo is the free-form map owned by AI and people. No code decides
	// anything from it.
	ScopeMemo = "memo"
)

// validateMemo requires scope.memo to be an object (or null to clear it).
func validateMemo(scope map[string]interface{}) error {
	v, ok := scope[ScopeMemo]
	if !ok || v == nil {
		return nil
	}
	if _, isMap := v.(map[string]interface{}); !isMap {
		return invalidf("scope.memo must be a JSON object")
	}
	return nil
}

// mergeScope applies a scope update onto the current scope. Keys replace,
// except scope.memo, which merges per key: a null member deletes it and null
// clears the map.
func mergeScope(cur, upd map[string]interface{}) map[string]interface{} {
	out := make(map[string]interface{}, len(cur)+len(upd))
	for k, v := range cur {
		out[k] = v
	}
	for k, v := range upd {
		if k != ScopeMemo {
			out[k] = v
			continue
		}
		in, isMap := v.(map[string]interface{})
		if !isMap {
			delete(out, ScopeMemo)
			continue
		}
		memo := map[string]interface{}{}
		if old, ok := out[ScopeMemo].(map[string]interface{}); ok {
			for mk, mv := range old {
				memo[mk] = mv
			}
		}
		for mk, mv := range in {
			if mv == nil {
				delete(memo, mk)
				continue
			}
			memo[mk] = mv
		}
		if len(memo) == 0 {
			delete(out, ScopeMemo)
			continue
		}
		out[ScopeMemo] = memo
	}
	return out
}
