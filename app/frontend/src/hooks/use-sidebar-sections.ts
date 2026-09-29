import { useLocalStorageBoolean } from "./use-local-storage-boolean";

/** The sidebar's toggleable sections. Sessions is deliberately excluded — the
 *  session tree is the always-on core nav surface and must not be hideable. */
export type SidebarSection = "boards" | "server" | "pane" | "host";

/** Ordered rail vocabulary: key, default visibility, and display label per
 *  section. Defaults reproduce the pre-rail rendering on both viewports
 *  (Boards/Server on, Pane/Host off). One shared key per section —
 *  no per-viewport fork, no per-route state. */
export const SIDEBAR_SECTIONS: readonly {
  section: SidebarSection;
  key: string;
  defaultValue: boolean;
  label: string;
}[] = [
  { section: "boards", key: "hexokit-sidebar-section-boards", defaultValue: true, label: "Boards" },
  { section: "server", key: "hexokit-sidebar-section-server", defaultValue: true, label: "Servers" },
  { section: "pane", key: "hexokit-sidebar-section-pane", defaultValue: false, label: "Pane" },
  { section: "host", key: "hexokit-sidebar-section-host", defaultValue: false, label: "Host" },
];

const SECTION_ENTRY = Object.fromEntries(
  SIDEBAR_SECTIONS.map((entry) => [entry.section, entry]),
) as Record<SidebarSection, (typeof SIDEBAR_SECTIONS)[number]>;

/**
 * Persisted visibility boolean for one sidebar section, shared reactively
 * across the section rail, the sidebar render, and the command-palette
 * entries (sibling subscribers via the boolean hook's in-module pub/sub;
 * cross-tab sync rides the native `storage` event).
 */
export function useSidebarSectionVisible(section: SidebarSection): [boolean, (next: boolean) => void] {
  const entry = SECTION_ENTRY[section];
  return useLocalStorageBoolean(entry.key, entry.defaultValue);
}
