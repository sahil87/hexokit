/**
 * Pure match-quality ranking for command-palette actions, layered on top of
 * the palette's filter step. Replaces "filter, then render in declaration
 * order" with a six-tier match ladder so the strongest match — not the
 * earliest-declared row — leads the list.
 *
 * Pure and dependency-free, per the lib/palette builder convention
 * (shell.ts, zen.ts, server-protect.ts): no React, no DOM, structurally
 * typed over `{ id, label, description? }` so it carries no component
 * dependency. `rankActions` subsumes the old filter — membership is a
 * SUPERSET of a case-insensitive `includes` over label + description, because
 * the Acronym tier necessarily admits matches that predicate rejects (`ns` →
 * `New Session`) — and returns a NEW array, never mutating the caller's
 * (upstream-memoized) list.
 */

/**
 * Ranking tiers, lower = better. A const object rather than an enum because
 * `isolatedModules` forbids const enums and bare integers would be magic
 * numbers.
 */
export const MatchTier = {
  /** The whole label equals the query, or the label's `"<Category>: "` prefix does. */
  Exact: 0,
  /** Some word of the label equals the query. */
  WholeWord: 1,
  /** Some word of the label starts with the query and is longer than it. */
  WordStart: 2,
  /** The query is a contiguous substring of the label's word-initials string. */
  Acronym: 3,
  /**
   * The label contains the query and no higher tier applied. An
   * alphanumeric query is then necessarily strictly inside a word (a
   * word-initial one would have hit WholeWord or WordStart); a query
   * spanning a boundary (`kit: r` → `run-kit: Restart Daemon`) also lands
   * here, which is what keeps membership a superset of the old filter.
   */
  Incidental: 4,
  /** The label does not contain the query; the description does. */
  DescriptionOnly: 5,
} as const;
export type MatchTier = (typeof MatchTier)[keyof typeof MatchTier];

const WORD_PATTERN = /[a-z0-9]+/g;
const CATEGORY_SEPARATOR = ": ";

/** A word is a maximal run of `[a-z0-9]`; every other character is a boundary. */
function tokenizeWords(lowercasedLabel: string): string[] {
  return lowercasedLabel.match(WORD_PATTERN) ?? [];
}

/**
 * The text before the label's first `": "`, lowercased (`PR: Refresh Status`
 * → `pr`; `run-kit: Restart Daemon` → `run-kit`); `null` when the label has
 * no `": "`.
 */
function extractCategory(label: string): string | null {
  const at = label.indexOf(CATEGORY_SEPARATOR);
  return at === -1 ? null : label.slice(0, at).toLowerCase();
}

/**
 * The tier for one label+description against a query, or `null` for no
 * match. The first tier whose rule holds wins. An empty query is out of
 * contract — `rankActions` short-circuits it before tiering.
 */
export function matchTier(
  label: string,
  description: string | undefined,
  query: string,
): MatchTier | null {
  const q = query.toLowerCase();
  const lower = label.toLowerCase();
  const category = extractCategory(label);
  if (lower === q || category === q) return MatchTier.Exact;

  const words = tokenizeWords(lower);
  if (words.some((w) => w === q)) return MatchTier.WholeWord;
  if (words.some((w) => w.length > q.length && w.startsWith(q))) {
    return MatchTier.WordStart;
  }
  const initials = words.map((w) => w[0]).join("");
  if (initials.includes(q)) return MatchTier.Acronym;
  if (lower.includes(q)) return MatchTier.Incidental;
  if (description?.toLowerCase().includes(q) ?? false) {
    return MatchTier.DescriptionOnly;
  }
  return null;
}

type Rankable = { id: string; label: string; description?: string };

/**
 * MRU position of an id: its index in the most-recent-first list, or
 * `Infinity` when absent (so present always beats absent).
 */
function mruRank(id: string, mru: readonly string[]): number {
  const at = mru.indexOf(id);
  return at === -1 ? Number.POSITIVE_INFINITY : at;
}

/**
 * Filter + rank `actions` against `query`. Ordering: tier ascending, then
 * density (`query.length / label.length`, label only — the description is
 * secondary text) descending, then MRU presence and recency, then
 * declaration order. An empty or whitespace-only query skips tiering:
 * everything renders, MRU-first then declaration order.
 */
export function rankActions<T extends Rankable>(
  actions: readonly T[],
  query: string,
  mru: readonly string[],
): T[] {
  if (query.trim() === "") {
    return actions
      .map((action, order) => ({ action, order, mru: mruRank(action.id, mru) }))
      .sort((a, b) => a.mru - b.mru || a.order - b.order)
      .map(({ action }) => action);
  }

  const q = query.toLowerCase();
  return actions
    .flatMap((action, order) => {
      const tier = matchTier(action.label, action.description, q);
      return tier === null
        ? []
        : [
            {
              action,
              order,
              tier,
              density: q.length / action.label.length,
              mru: mruRank(action.id, mru),
            },
          ];
    })
    .sort(
      (a, b) =>
        a.tier - b.tier ||
        b.density - a.density ||
        a.mru - b.mru ||
        a.order - b.order,
    )
    .map(({ action }) => action);
}
