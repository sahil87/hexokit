/**
 * Pure builder for the command-palette version entry (`HexoKit: Version —
 * v{version}`). Follows the lib/palette/update.ts pattern (pure,
 * dependency-free, unit-testable) so the label composition and null-gating are
 * verifiable without mounting the shell. The action body (copy-to-clipboard +
 * toast) is a thin `onSelect` passed in by the caller.
 *
 * Unlike the update/restart actions, this entry is pure DISPLAY, so it is shown
 * whenever a version is known — INCLUDING the `dev` sentinel (there is no dev
 * gate here; the only gate is a non-null version).
 */

export type VersionPaletteAction = {
  id: string;
  label: string;
  onSelect: () => void;
};

/**
 * Format a version for display, mirroring the backend `displayVersion()`
 * (app/backend/cmd/rk/root.go): prefix a `v` to a numeric version, leave the
 * `dev` sentinel (and any already-`v`-prefixed string) bare so we never render
 * `vdev` or `vv0.6.2`. This is the single frontend source of the v-prefix
 * convention — reused by the connection-dot title and the Host stamp.
 */
export function displayVersion(version: string): string {
  if (version === "dev" || version.startsWith("v")) return version;
  return `v${version}`;
}

/**
 * Build the version palette entry. Returns an empty array when `version` is null
 * (no `event: version` seen yet — omit rather than render a placeholder), and
 * otherwise a single action whose LABEL carries the displayed version so typing
 * "version" in the palette answers "what am I on?" without selecting anything.
 */
export function buildVersionAction(
  version: string | null,
  onSelect: () => void,
): VersionPaletteAction[] {
  if (!version) return [];
  return [
    {
      id: "run-kit-version",
      label: `HexoKit: Version — ${displayVersion(version)}`,
      onSelect,
    },
  ];
}
