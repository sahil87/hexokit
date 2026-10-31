import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { getDirectories } from "@/api/client";
import { controlClass } from "@/components/control";
import { INPUT_COARSE, INPUT_FOCUS } from "@/components/controls";
import { LogoSpinner } from "@/components/logo-spinner";
import type { ProjectSession } from "@/types";

/** Distinct project roots (each group's first-tab worktree path), sorted — the
 *  quick-picks shown while the folder input is empty. */
export function projectRoots(sessions: ProjectSession[]): string[] {
  const paths = new Set<string>();
  for (const s of sessions) {
    const root = s.windows[0]?.worktreePath;
    if (root) paths.add(root);
  }
  return [...paths].sort();
}

/** Distinct worktree paths of EVERY tab across `sessions`, sorted — the New
 *  sheet's "Open elsewhere" source (`projectRoots` widened past each group's
 *  first tab). */
export function tabFolders(sessions: ProjectSession[]): string[] {
  const paths = new Set<string>();
  for (const s of sessions) {
    for (const w of s.windows) {
      if (w.worktreePath) paths.add(w.worktreePath);
    }
  }
  return [...paths].sort();
}

/** Debounced `getDirectories` autocomplete state, shared by the combobox and
 *  the New sheet. `request` schedules a lookup for the typed value (an empty
 *  value clears); `clear` drops results without a lookup (after a pick). */
export function useDirectorySuggestions() {
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const request = useCallback((next: string) => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!next) {
      setSuggestions([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    debounceRef.current = setTimeout(async () => {
      try {
        setSuggestions(await getDirectories(next));
      } catch {
        // Ignore
      } finally {
        setLoading(false);
      }
    }, 300);
  }, []);

  const clear = useCallback(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    setSuggestions([]);
    setLoading(false);
  }, []);

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  return { suggestions, loading, request, clear };
}

type FolderPathInputProps = {
  value: string;
  onChange: (value: string) => void;
  /** Called on Enter when no dropdown option is highlighted. */
  onSubmit?: () => void;
  /** Dropdown entries while `value` is empty (see `projectRoots`). */
  quickPicks: string[];
  autoFocus?: boolean;
  ariaLabel?: string;
  placeholder?: string;
};

/**
 * Folder combobox: quick-picks while empty, debounced directory autocomplete
 * while typing, ↑/↓/Enter/Esc navigation. Controlled — selecting a suggestion
 * reports it through `onChange` like typing does.
 */
export function FolderPathInput({
  value,
  onChange,
  onSubmit,
  quickPicks,
  autoFocus,
  ariaLabel = "Project path",
  placeholder = "~/code/...",
}: FolderPathInputProps) {
  const { suggestions, loading: isLoadingSuggestions, request: fetchSuggestions, clear: clearSuggestions } = useDirectorySuggestions();
  const [showDropdown, setShowDropdown] = useState(false);
  const [highlightIndex, setHighlightIndex] = useState(-1);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const baseId = useId();
  const listId = `${baseId}-suggestions`;
  const optionId = (i: number) => `${baseId}-option-${i}`;

  // Suggestions win; otherwise an empty input shows the quick-picks.
  const dropdownItems = useMemo(() => {
    if (suggestions.length > 0) return suggestions;
    if (!value) return quickPicks;
    return [];
  }, [suggestions, value, quickPicks]);

  function selectPath(p: string) {
    onChange(p);
    clearSuggestions();
    setShowDropdown(false);
    setHighlightIndex(-1);
  }

  function handleChange(next: string) {
    onChange(next);
    setShowDropdown(true);
    fetchSuggestions(next);
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (!showDropdown || dropdownItems.length === 0) {
      if (e.key === "ArrowDown" && dropdownItems.length > 0) {
        setShowDropdown(true);
        setHighlightIndex(0);
        e.preventDefault();
        return;
      }
      if (e.key === "Enter") onSubmit?.();
      return;
    }

    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setHighlightIndex((i) => (i + 1) % dropdownItems.length);
        break;
      case "ArrowUp":
        e.preventDefault();
        setHighlightIndex((i) => (i <= 0 ? dropdownItems.length - 1 : i - 1));
        break;
      case "Enter":
        e.preventDefault();
        if (highlightIndex >= 0 && highlightIndex < dropdownItems.length) {
          selectPath(dropdownItems[highlightIndex]);
        } else {
          onSubmit?.();
        }
        break;
      case "Escape":
        e.preventDefault();
        setShowDropdown(false);
        setHighlightIndex(-1);
        break;
    }
  }

  // A highlight points into one result list: reset it when the results change
  // (not on keystroke, so an arrow pressed during the debounce survives only
  // until the new list lands).
  useEffect(() => {
    setHighlightIndex(-1);
  }, [suggestions]);

  useEffect(() => {
    if (highlightIndex < 0 || !dropdownRef.current) return;
    const el = dropdownRef.current.children[highlightIndex] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }, [highlightIndex]);

  return (
    <div className="relative">
      <div className="relative">
        <input
          ref={inputRef}
          autoFocus={autoFocus}
          type="text"
          value={value}
          onChange={(e) => handleChange(e.target.value)}
          onFocus={() => setShowDropdown(true)}
          onBlur={() => {
            // Delay to allow click on dropdown item
            setTimeout(() => setShowDropdown(false), 150);
          }}
          onKeyDown={handleKeyDown}
          role="combobox"
          aria-expanded={showDropdown && dropdownItems.length > 0}
          aria-controls={listId}
          aria-activedescendant={highlightIndex >= 0 ? optionId(highlightIndex) : undefined}
          aria-label={ariaLabel}
          placeholder={placeholder}
          className={`w-full bg-transparent text-text-primary p-2 pr-7 border border-border rounded ${INPUT_FOCUS} ${INPUT_COARSE} placeholder:text-text-secondary`}
        />
        {isLoadingSuggestions && (
          <span className="absolute right-2 top-1/2 -translate-y-1/2 text-text-secondary">
            <LogoSpinner size={14} />
          </span>
        )}
      </div>
      {showDropdown && dropdownItems.length > 0 && (
        <div
          ref={dropdownRef}
          id={listId}
          role="listbox"
          aria-label="Directory suggestions"
          className="absolute left-0 right-0 top-full mt-1 bg-bg-primary border border-border rounded shadow-lg max-h-48 overflow-y-auto z-50"
        >
          {dropdownItems.map((dir, i) => (
            <button
              key={dir}
              id={optionId(i)}
              role="option"
              aria-selected={i === highlightIndex}
              onMouseDown={(e) => {
                e.preventDefault(); // prevent blur
                selectPath(dir);
                inputRef.current?.focus();
              }}
              className={`w-full text-left px-2 py-1.5 transition-colors ${controlClass({ variant: "wide", bare: true })} ${
                i === highlightIndex
                  ? "bg-bg-card text-text-primary"
                  : "text-text-secondary hover:bg-bg-card hover:text-text-primary"
              }`}
            >
              {dir}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
