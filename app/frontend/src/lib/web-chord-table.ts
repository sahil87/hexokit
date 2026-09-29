/**
 * The native engine's chord table — the reclaim predicate, enumerated.
 *
 * A guest `WebContentsView`'s keydowns never reach the SPA document, so
 * `hasReclaimableMatch` cannot run at event time there. Instead the SPA
 * enumerates its kind-`"web"` answer over the effective binding registry into
 * a concrete table, uploads it (`web:chords`), and main matches
 * `before-input-event` against it with exact modifier equality — the registry
 * stays the single authority (a rebind re-derives the table and moves both
 * engines) and main stays dumb and testable.
 *
 * The per-tier expansion mirrors `matchesCombo`'s acceptance exactly:
 * `cmd` accepts Ctrl OR Meta without Shift; `shifted` accepts Shift+Ctrl OR
 * Shift+Meta; `ctrl` accepts Ctrl alone; Alt is rejected in every tier. A
 * plain `{code: "Escape"}` spec is appended last, always — Escape is the
 * focus-return chord and is not a registry binding.
 */
import type { EffectiveBinding } from "@/lib/keybindings";

/** One reclaimable chord for the shell-side matcher: a key code plus its
 *  exact modifier set. `alt` is always `false` (the registry has no Alt
 *  tier); the field exists so the main-side match is exact equality. */
export interface WebChordSpec {
  code: string;
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
  alt: false;
  /** Skip main's host focus hop: set on the keyboard-capture toggle's arms,
   *  whose result is "keep typing in the page" — hopping focus to the SPA
   *  would send the next chord to rk instead of the page it was captured for. */
  keepFocus?: true;
}

/** The combos `matchesCombo` accepts for a binding's `{code, tier}`. */
function combosFor(code: string, tier: EffectiveBinding["tier"]): WebChordSpec[] {
  switch (tier) {
    case "cmd":
      return [
        { code, ctrl: true, meta: false, shift: false, alt: false },
        { code, ctrl: false, meta: true, shift: false, alt: false },
      ];
    case "shifted":
      return [
        { code, ctrl: true, meta: false, shift: true, alt: false },
        { code, ctrl: false, meta: true, shift: true, alt: false },
      ];
    case "ctrl":
      return [{ code, ctrl: true, meta: false, shift: false, alt: false }];
  }
}

/**
 * The per-guest chord table over the effective registry: every enabled
 * binding that `hasReclaimableMatch` would reclaim under kind `"web"` —
 * ungated and `webOnly` bindings; never `ttyOnly` or `guiOnly` — expanded per
 * tier, deduped by the five-tuple, in registry order, Escape last.
 *
 * `captured` is the web keyboard-capture latch (`rk-web-capture`): when set
 * the table narrows to the release binding (`web-capture-toggle`) ALONE — no
 * other chord and no Escape — so main reclaims only that and every other key,
 * Escape included, reaches the page (the `hasReclaimableMatch` captured
 * narrowing, enumerated). The toggle's arms carry `keepFocus` in both states,
 * so flipping capture from inside the page leaves OS focus in the guest.
 */
export function buildWebChordTable(
  bindings: readonly EffectiveBinding[],
  captured = false,
): WebChordSpec[] {
  const seen = new Set<string>();
  const specs: WebChordSpec[] = [];
  const push = (spec: WebChordSpec): void => {
    const key = `${spec.code}${spec.ctrl}${spec.meta}${spec.shift}${spec.alt}`;
    if (seen.has(key)) return;
    seen.add(key);
    specs.push(spec);
  };
  for (const binding of bindings) {
    if (!binding.enabled || binding.ttyOnly || binding.guiOnly) continue;
    if (binding.code === "") continue;
    const toggle = binding.actionId === "web-capture-toggle";
    if (captured && !toggle) continue;
    for (const spec of combosFor(binding.code, binding.tier)) {
      push(toggle ? { ...spec, keepFocus: true } : spec);
    }
  }
  if (!captured) push({ code: "Escape", ctrl: false, meta: false, shift: false, alt: false });
  return specs;
}
