import { createContext, useContext, useState, useCallback, useEffect, useMemo, useRef } from "react";
import {
  getThemeById,
  DEFAULT_DARK_THEME,
  DEFAULT_LIGHT_THEME,
  COLOR_CSS_MAP,
  deriveUIColors,
} from "@/themes";
import type { Theme, UIColors } from "@/themes";
import { getThemePreference, setThemePreference } from "@/api/client";
import { applyThemeColorMeta } from "@/instance-accent";

export type ResolvedTheme = "light" | "dark";

type ThemeState = {
  preference: string;
  themeDark: string;
  themeLight: string;
  resolved: ResolvedTheme;
  theme: Theme;
};

type ThemeActions = {
  setTheme: (preference: string) => void;
  previewTheme: (theme: Theme) => void;
  cancelPreview: () => void;
};

const THEME_STORAGE_KEY = "hexokit-theme";
const THEME_DARK_STORAGE_KEY = "hexokit-theme-dark";
const THEME_LIGHT_STORAGE_KEY = "hexokit-theme-light";

const ThemeStateContext = createContext<ThemeState | null>(null);
const ThemeActionsContext = createContext<ThemeActions | null>(null);

function resolveThemeObject(preference: string, themeDark: string, themeLight: string): Theme {
  if (preference === "system") {
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    if (prefersDark) {
      return getThemeById(themeDark) ?? DEFAULT_DARK_THEME;
    }
    return getThemeById(themeLight) ?? DEFAULT_LIGHT_THEME;
  }
  return getThemeById(preference) ?? DEFAULT_DARK_THEME;
}

function readPreference(): { preference: string; themeDark: string; themeLight: string } {
  let preference = "system";
  let themeDark = "default-dark";
  let themeLight = "default-light";
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === "system") {
      preference = "system";
    } else if (stored && getThemeById(stored)) {
      preference = stored;
    }
    const storedDark = localStorage.getItem(THEME_DARK_STORAGE_KEY);
    if (storedDark && getThemeById(storedDark)) {
      themeDark = storedDark;
    }
    const storedLight = localStorage.getItem(THEME_LIGHT_STORAGE_KEY);
    if (storedLight && getThemeById(storedLight)) {
      themeLight = storedLight;
    }
  } catch {
    // localStorage unavailable
  }
  return { preference, themeDark, themeLight };
}

function applyThemeToDOM(theme: Theme): void {
  const root = document.documentElement;

  // Derive the 11 UI colors from the full palette
  const uiColors: UIColors = deriveUIColors(theme.palette, theme.category);

  // Set all 11 CSS custom properties
  const colorKeys = Object.keys(COLOR_CSS_MAP) as (keyof UIColors)[];
  for (const key of colorKeys) {
    root.style.setProperty(COLOR_CSS_MAP[key], uiColors[key]);
  }

  // Set data-theme to category
  root.dataset.theme = theme.category;

  // Set color-scheme
  root.style.setProperty("color-scheme", theme.category);

  // Update meta theme-color through the shared single writer — the instance
  // accent (when resolved) wins over the bare chrome, and funneling both
  // writers through one module removes the child-vs-parent effect-ordering
  // race that would otherwise let a theme switch clobber the accent tint.
  // The chrome hex is the titlebar's truthful neighbor: the top bar paints it.
  applyThemeColorMeta(uiColors.bgChrome);
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const initial = readPreference();
  const [preference, setPreference] = useState<string>(initial.preference);
  const [themeDark, setThemeDark] = useState<string>(initial.themeDark);
  const [themeLight, setThemeLight] = useState<string>(initial.themeLight);
  const [activeTheme, setActiveTheme] = useState<Theme>(() =>
    resolveThemeObject(initial.preference, initial.themeDark, initial.themeLight),
  );
  const [isPreview, setIsPreview] = useState(false);
  const persistedPreferenceRef = useRef(preference);
  const themeDarkRef = useRef(themeDark);
  const themeLightRef = useRef(themeLight);

  // Apply theme to DOM whenever activeTheme changes
  useEffect(() => {
    applyThemeToDOM(activeTheme);
  }, [activeTheme]);

  // On mount: load theme preference from API, fall back to localStorage
  useEffect(() => {
    let cancelled = false;
    getThemePreference()
      .then((apiPrefs) => {
        if (cancelled) return;
        // Validate the API values
        const validPref =
          apiPrefs.theme === "system" || getThemeById(apiPrefs.theme) ? apiPrefs.theme : "system";
        const validDark = getThemeById(apiPrefs.themeDark) ? apiPrefs.themeDark : "default-dark";
        const validLight = getThemeById(apiPrefs.themeLight) ? apiPrefs.themeLight : "default-light";

        setPreference(validPref);
        setThemeDark(validDark);
        setThemeLight(validLight);
        persistedPreferenceRef.current = validPref;
        themeDarkRef.current = validDark;
        themeLightRef.current = validLight;
        setActiveTheme(resolveThemeObject(validPref, validDark, validLight));
        // Update localStorage cache
        try {
          localStorage.setItem(THEME_STORAGE_KEY, validPref);
          localStorage.setItem(THEME_DARK_STORAGE_KEY, validDark);
          localStorage.setItem(THEME_LIGHT_STORAGE_KEY, validLight);
        } catch {
          // localStorage unavailable
        }
      })
      .catch(() => {
        // API failed — keep localStorage/default value
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Listen to OS preference changes when in "system" mode
  useEffect(() => {
    if (preference !== "system") return;

    const mql = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = (e: MediaQueryListEvent) => {
      const nextTheme = e.matches
        ? (getThemeById(themeDarkRef.current) ?? DEFAULT_DARK_THEME)
        : (getThemeById(themeLightRef.current) ?? DEFAULT_LIGHT_THEME);
      setActiveTheme(nextTheme);
    };

    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }, [preference]);

  const setTheme = useCallback((next: string) => {
    if (next === "system") {
      // System mode — OS picks between per-mode prefs
      try {
        localStorage.setItem(THEME_STORAGE_KEY, "system");
      } catch {
        // localStorage unavailable
      }
      setThemePreference({ theme: "system" }).catch(() => {});
      setPreference("system");
      persistedPreferenceRef.current = "system";
      setActiveTheme(resolveThemeObject("system", themeDarkRef.current, themeLightRef.current));
      setIsPreview(false);
      return;
    }

    const theme = getThemeById(next);
    if (!theme) {
      // Unknown theme ID, fall back to system
      try {
        localStorage.setItem(THEME_STORAGE_KEY, "system");
      } catch {
        // localStorage unavailable
      }
      setThemePreference({ theme: "system" }).catch(() => {});
      setPreference("system");
      persistedPreferenceRef.current = "system";
      setActiveTheme(resolveThemeObject("system", themeDarkRef.current, themeLightRef.current));
      setIsPreview(false);
      return;
    }

    // Known theme: update per-mode slot and set preference to this theme ID
    let nextDark = themeDarkRef.current;
    let nextLight = themeLightRef.current;

    if (theme.category === "dark") {
      nextDark = next;
      setThemeDark(nextDark);
      themeDarkRef.current = nextDark;
    } else {
      nextLight = next;
      setThemeLight(nextLight);
      themeLightRef.current = nextLight;
    }

    // Preference = the specific theme ID (not "system")
    setPreference(next);
    persistedPreferenceRef.current = next;
    setActiveTheme(theme);
    setIsPreview(false);

    // Persist all values
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next);
      localStorage.setItem(THEME_DARK_STORAGE_KEY, nextDark);
      localStorage.setItem(THEME_LIGHT_STORAGE_KEY, nextLight);
    } catch {
      // localStorage unavailable
    }

    const apiPayload: { theme: string; themeDark?: string; themeLight?: string } = {
      theme: next,
    };
    if (theme.category === "dark") {
      apiPayload.themeDark = nextDark;
    } else {
      apiPayload.themeLight = nextLight;
    }
    setThemePreference(apiPayload).catch(() => {});
  }, []);

  const previewTheme = useCallback((theme: Theme) => {
    setActiveTheme(theme);
    setIsPreview(true);
  }, []);

  const cancelPreview = useCallback(() => {
    if (!isPreview) return;
    const restoredTheme = resolveThemeObject(
      persistedPreferenceRef.current,
      themeDarkRef.current,
      themeLightRef.current,
    );
    setActiveTheme(restoredTheme);
    setIsPreview(false);
  }, [isPreview]);

  const resolved: ResolvedTheme = activeTheme.category;

  const stateValue = useMemo<ThemeState>(
    () => ({ preference, themeDark, themeLight, resolved, theme: activeTheme }),
    [preference, themeDark, themeLight, resolved, activeTheme],
  );

  // Stabilize actions via ref — but update the ref when callbacks change
  const actionsRef = useRef<ThemeActions>({ setTheme, previewTheme, cancelPreview });
  actionsRef.current = { setTheme, previewTheme, cancelPreview };

  // Stable wrapper that delegates to latest ref
  const stableActions = useMemo<ThemeActions>(() => ({
    setTheme: (p: string) => actionsRef.current.setTheme(p),
    previewTheme: (t: Theme) => actionsRef.current.previewTheme(t),
    cancelPreview: () => actionsRef.current.cancelPreview(),
  }), []);

  return (
    <ThemeStateContext.Provider value={stateValue}>
      <ThemeActionsContext.Provider value={stableActions}>
        {children}
      </ThemeActionsContext.Provider>
    </ThemeStateContext.Provider>
  );
}

export function useTheme(): ThemeState {
  const state = useContext(ThemeStateContext);
  if (!state) throw new Error("useTheme must be used within ThemeProvider");
  return state;
}

export function useThemeActions(): ThemeActions {
  const actions = useContext(ThemeActionsContext);
  if (!actions) throw new Error("useThemeActions must be used within ThemeProvider");
  return actions;
}
