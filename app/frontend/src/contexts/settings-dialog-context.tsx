import { createContext, useContext, useState, useCallback, useMemo } from "react";

/** The settings dialog's tabs — a closed union (no casts). */
export type SettingsTab = "general" | "appearance" | "agents" | "all" | "shortcuts";

/**
 * Settings-dialog state (260723-o7q8; tabbed in 260818-bncw). Provided at the
 * `AppLayout` level — the true every-page layer (boards included) — so any
 * descendant (command-palette actions, the top-bar Settings gear — 260812-d1at,
 * the overflow menu's Keyboard-shortcuts row) can deep-link a tab via
 * `openSettings(tab?)` while the dialog itself renders exactly once in
 * `AppLayout`. Deliberately small: instance data (display name, accent) lives
 * in its own contexts.
 */
export type SettingsDialogState = {
  isOpen: boolean;
  activeTab: SettingsTab;
  /** With a tab: opens (if closed) and activates that tab. Tab-less: opens on
   *  General when closed; a tab-preserving no-op when already open. No
   *  last-tab persistence — a tab-less reopen always lands on General. */
  openSettings: (tab?: SettingsTab) => void;
  closeSettings: () => void;
  setActiveTab: (tab: SettingsTab) => void;
};

const SettingsDialogContext = createContext<SettingsDialogState | null>(null);

export function SettingsDialogProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<{ isOpen: boolean; activeTab: SettingsTab }>({
    isOpen: false,
    activeTab: "general",
  });

  const openSettings = useCallback((tab?: SettingsTab) => {
    setState((s) =>
      s.isOpen
        ? tab !== undefined && tab !== s.activeTab
          ? { isOpen: true, activeTab: tab }
          : s
        : { isOpen: true, activeTab: tab ?? "general" },
    );
  }, []);
  const closeSettings = useCallback(
    () => setState((s) => (s.isOpen ? { ...s, isOpen: false } : s)),
    [],
  );
  const setActiveTab = useCallback(
    (tab: SettingsTab) => setState((s) => (s.activeTab === tab ? s : { ...s, activeTab: tab })),
    [],
  );

  const value = useMemo<SettingsDialogState>(
    () => ({
      isOpen: state.isOpen,
      activeTab: state.activeTab,
      openSettings,
      closeSettings,
      setActiveTab,
    }),
    [state, openSettings, closeSettings, setActiveTab],
  );

  return (
    <SettingsDialogContext.Provider value={value}>{children}</SettingsDialogContext.Provider>
  );
}

export function useSettingsDialog(): SettingsDialogState {
  const ctx = useContext(SettingsDialogContext);
  if (!ctx) throw new Error("useSettingsDialog must be used within SettingsDialogProvider");
  return ctx;
}
