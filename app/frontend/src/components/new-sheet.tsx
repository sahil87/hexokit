import { useEffect, useId, useMemo, useRef, useState } from "react";
import { getWorktrees, type WorktreesResponse } from "@/api/client";
import { Control, controlClass } from "@/components/control";
import { Dialog } from "@/components/dialog";
import { INPUT_COARSE, INPUT_FOCUS } from "@/components/controls";
import { tabFolders, useDirectorySuggestions } from "@/components/folder-path-input";
import { useKeybindings } from "@/hooks/use-keybindings";
import { chordHintFor } from "@/lib/keybindings";
import { finalizeSafeName, toSafeServerName, toSafeSessionName } from "@/lib/names";
import {
  LEVEL_LABEL,
  NEW_LEVELS,
  buildFolderSections,
  countTabsByFolder,
  cycleLevel,
  deriveSheetName,
  isListMatch,
  normalizeFolder,
  previewFor,
  windowBranch,
  type FolderRow,
  type NewLevel,
} from "@/lib/new-sheet";
import type { ProjectSession } from "@/types";

const SERVER_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;

/** The footer hints' keycap — the palette rows' kbd weight without the
 *  row-pinned `ml-auto`. */
const HINT_KBD_CLASS = "text-xs text-text-secondary bg-bg-card px-1.5 py-0.5 rounded border border-border";

/** The registry action whose chord labels each level's button. The group chord
 *  is the instant `create-session` binding until a dedicated one exists. */
const LEVEL_CHORD_ACTION: Record<NewLevel, string> = {
  tab: "create-window",
  group: "create-session",
  workspace: "",
};

export type NewSheetSubmit = {
  level: NewLevel;
  /** Trimmed folder as typed/picked; undefined when blank. */
  folder: string | undefined;
  /** Finalized name for group/workspace; undefined for tabs. */
  name: string | undefined;
};

type NewSheetProps = {
  initialLevel: NewLevel;
  /** Levels with a valid target here (the host page offers only `workspace`). */
  availableLevels: readonly NewLevel[];
  /** Workspace the tab/group will land in, for the preview ("" when none). */
  server: string;
  /** The group a new tab lands in ("" when none). */
  group: string;
  /** The workspace's groups: the "Open elsewhere" source and group-name dedupe. */
  sessions: ProjectSession[];
  /** Live workspace names, for workspace-name dedupe and the collision rule. */
  workspaceNames: string[];
  /** The field's prefill. */
  contextFolder: string;
  contextBranch?: string;
  onSubmit: (submit: NewSheetSubmit) => void;
  onClose: () => void;
};

function FolderRowButton({
  row,
  id,
  selected,
  onPick,
}: {
  row: FolderRow;
  id: string;
  selected: boolean;
  onPick: (path: string) => void;
}) {
  return (
    <button
      type="button"
      id={id}
      role="option"
      aria-selected={selected}
      tabIndex={-1}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => onPick(row.path)}
      className={`${controlClass({ variant: "wide", bare: true })} w-full text-left flex items-center gap-2 px-2 py-1.5 transition-colors ${
        selected ? "bg-bg-card text-text-primary" : "text-text-secondary hover:bg-bg-card hover:text-text-primary"
      }`}
    >
      <span className="truncate">{row.path}</span>
      {row.branch && (
        <span className="shrink-0 rounded border border-border px-1 text-[10px] text-accent-green">{row.branch}</span>
      )}
      {row.meta && <span className="ml-auto shrink-0 text-[10px] text-text-secondary">{row.meta}</span>}
    </button>
  );
}

/**
 * The folder-first "New" sheet: one flow for a tab, a group, or a workspace.
 * The folder is the primary input; names derive from it and a live preview
 * states exactly what Create will do. Mounted only while open, so its state
 * resets on close. The caller (`NewSheetHost`) owns the create actions.
 */
export function NewSheet({
  initialLevel,
  availableLevels,
  server,
  group,
  sessions,
  workspaceNames,
  contextFolder,
  contextBranch,
  onSubmit,
  onClose,
}: NewSheetProps) {
  const [level, setLevel] = useState<NewLevel>(
    availableLevels.includes(initialLevel) ? initialLevel : (availableLevels[0] ?? "workspace"),
  );
  const [folder, setFolder] = useState(() => (contextFolder ? normalizeFolder(contextFolder) : ""));
  const [nameEditing, setNameEditing] = useState(false);
  const [typedName, setTypedName] = useState<string | null>(null);
  const [suggestIndex, setSuggestIndex] = useState(-1);
  const [worktrees, setWorktrees] = useState<WorktreesResponse>({ repo: "", worktrees: [] });
  const folderRef = useRef<HTMLInputElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const listId = useId();
  const { suggestions, loading, request, clear } = useDirectorySuggestions();
  const { bindings, host } = useKeybindings();

  useEffect(() => {
    folderRef.current?.focus();
    folderRef.current?.select();
  }, []);

  useEffect(() => {
    if (!contextFolder) return;
    let cancelled = false;
    getWorktrees(contextFolder)
      .then((res) => {
        if (!cancelled) setWorktrees(res);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [contextFolder]);

  useEffect(() => {
    if (nameEditing) {
      nameRef.current?.focus();
      nameRef.current?.select();
    }
  }, [nameEditing]);

  const sections = useMemo(() => {
    const tabCounts = countTabsByFolder(sessions);
    const branchByFolder = new Map<string, string>();
    for (const s of sessions) {
      for (const w of s.windows) {
        const branch = windowBranch(w);
        if (w.worktreePath && branch) branchByFolder.set(normalizeFolder(w.worktreePath), branch);
      }
    }
    return buildFolderSections({
      contextFolder,
      contextBranch,
      repo: worktrees.repo,
      worktrees: worktrees.worktrees,
      openFolders: tabFolders(sessions),
      tabCounts,
      branchByFolder,
    });
  }, [sessions, contextFolder, contextBranch, worktrees]);

  const listRows = useMemo(() => sections.flatMap((s) => s.rows), [sections]);
  const listMode = isListMatch(folder, sections);
  const selectedPath = normalizeFolder(folder);

  const hasName = level !== "tab";
  const existingNames = useMemo(
    () => (level === "workspace" ? workspaceNames : sessions.map((s) => s.name)),
    [level, workspaceNames, sessions],
  );
  const derivedName = hasName ? deriveSheetName(level === "group" ? "group" : "workspace", folder, existingNames) : "";
  const shownName = typedName ?? derivedName;
  const finalName = nameEditing ? finalizeSafeName(shownName.trim()) : derivedName;
  const nameTaken = nameEditing && finalName !== "" && existingNames.includes(finalName);
  const nameValid =
    !hasName || (finalName !== "" && !nameTaken && (level !== "workspace" || SERVER_NAME_PATTERN.test(finalName)));

  const preview = previewFor({ level, server, group, name: finalName || derivedName, folder });
  const noun = LEVEL_LABEL[level].toLowerCase();

  function chooseLevel(next: NewLevel) {
    if (next === level || !availableLevels.includes(next)) return;
    setLevel(next);
    setNameEditing(false);
    setTypedName(null);
  }

  function changeFolder(next: string) {
    setFolder(next);
    setSuggestIndex(-1);
    if (isListMatch(next, sections)) clear();
    else request(next);
  }

  function pickRow(path: string) {
    setFolder(path);
    setSuggestIndex(-1);
    clear();
    folderRef.current?.focus();
  }

  function submit() {
    if (!nameValid) return;
    onSubmit({
      level,
      folder: folder.trim() || undefined,
      name: hasName ? finalName : undefined,
    });
  }

  function openNameOverride() {
    if (!hasName) return;
    setTypedName(null);
    setNameEditing(true);
  }

  function handleFolderKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Tab") {
      e.preventDefault();
      setLevel((cur) => cycleLevel(cur, e.shiftKey ? -1 : 1, availableLevels));
      setNameEditing(false);
      setTypedName(null);
      return;
    }
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      openNameOverride();
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      const delta = e.key === "ArrowDown" ? 1 : -1;
      if (listMode) {
        if (listRows.length === 0) return;
        e.preventDefault();
        const at = listRows.findIndex((r) => r.path === selectedPath);
        const next = at < 0 ? (delta === 1 ? 0 : listRows.length - 1) : (at + delta + listRows.length) % listRows.length;
        setFolder(listRows[next].path);
      } else if (suggestions.length > 0) {
        e.preventDefault();
        setSuggestIndex((i) => (i < 0 ? (delta === 1 ? 0 : suggestions.length - 1) : (i + delta + suggestions.length) % suggestions.length));
      }
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      // A highlighted autocomplete row is navigation (fill the field); only an
      // un-highlighted Enter creates.
      if (!listMode && suggestIndex >= 0 && suggestIndex < suggestions.length) {
        pickRow(suggestions[suggestIndex]);
        return;
      }
      submit();
    }
  }

  function handleNameKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      submit();
    }
  }

  const optionId = (i: number) => `${listId}-opt-${i}`;
  let flatIndex = 0;

  return (
    <Dialog title="New" size="sheet" onClose={onClose}>
      <div role="group" aria-label="What to create" className="mb-3 flex items-center gap-1">
        {NEW_LEVELS.map((l) => {
          const action = LEVEL_CHORD_ACTION[l];
          const chord = action ? chordHintFor(action, bindings, host.platform) : undefined;
          return (
            <Control
              key={l}
              variant="segment"
              pressed={level === l}
              disabled={!availableLevels.includes(l)}
              onClick={() => chooseLevel(l)}
              className="px-2 gap-1.5"
            >
              {LEVEL_LABEL[l]}
              {chord && (
                <kbd aria-hidden="true" className="text-[10px] text-text-secondary">
                  {chord}
                </kbd>
              )}
            </Control>
          );
        })}
      </div>

      <label className="mb-1 block text-[10px] uppercase tracking-wide text-text-secondary" htmlFor={`${listId}-folder`}>
        folder
      </label>
      <input
        id={`${listId}-folder`}
        ref={folderRef}
        type="text"
        role="combobox"
        aria-expanded={true}
        aria-controls={listId}
        aria-activedescendant={!listMode && suggestIndex >= 0 ? optionId(suggestIndex) : undefined}
        aria-label="Folder"
        value={folder}
        onChange={(e) => changeFolder(e.target.value)}
        onKeyDown={handleFolderKeyDown}
        placeholder="~/code/..."
        className={`w-full bg-transparent text-text-primary p-2 border border-border rounded ${INPUT_FOCUS} ${INPUT_COARSE} placeholder:text-text-secondary`}
      />

      <div id={listId} role="listbox" aria-label="Folders" className="mt-1.5 max-h-52 overflow-y-auto">
        {listMode ? (
          sections.map((s) => (
            <div key={s.key} role="group" aria-label={s.title}>
              <p className="px-2 pt-1.5 pb-0.5 text-[10px] uppercase tracking-wide text-text-secondary">{s.title}</p>
              {s.rows.map((row) => {
                const i = flatIndex++;
                return (
                  <FolderRowButton
                    key={row.path}
                    row={row}
                    id={optionId(i)}
                    selected={row.path === selectedPath}
                    onPick={pickRow}
                  />
                );
              })}
            </div>
          ))
        ) : (
          <div role="group" aria-label="Folders">
            <p className="px-2 pt-1.5 pb-0.5 text-[10px] uppercase tracking-wide text-text-secondary">
              {loading ? "Searching…" : "Folders"}
            </p>
            {suggestions.map((dir, i) => (
              <FolderRowButton
                key={dir}
                row={{ path: dir }}
                id={optionId(i)}
                selected={i === suggestIndex}
                onPick={pickRow}
              />
            ))}
            {!loading && suggestions.length === 0 && (
              <p className="px-2 py-1.5 text-text-secondary">No matching folders — Enter creates at the typed path</p>
            )}
          </div>
        )}
      </div>

      <div className="mt-2.5 rounded border border-border bg-bg-inset px-2 py-1.5" aria-label="Preview">
        <p className="text-text-primary">{preview.text}</p>
        <ul aria-hidden="true" className="mt-1 font-mono text-[10px] leading-tight text-text-secondary">
          {preview.tree.map((node, depth) => (
            <li key={depth} style={{ paddingLeft: `${depth * 12}px` }} className={node.isNew ? "text-accent-green" : undefined}>
              {depth > 0 ? "└ " : ""}
              {node.isNew ? "+ " : ""}
              {node.label}
            </li>
          ))}
        </ul>
      </div>

      {nameEditing && (
        <div className="mt-2.5">
          <label className="mb-1 block text-[10px] uppercase tracking-wide text-text-secondary" htmlFor={`${listId}-name`}>
            {noun} name
          </label>
          <input
            id={`${listId}-name`}
            ref={nameRef}
            type="text"
            value={shownName}
            onChange={(e) =>
              setTypedName(level === "workspace" ? toSafeServerName(e.target.value) : toSafeSessionName(e.target.value))
            }
            onKeyDown={handleNameKeyDown}
            aria-label={`${LEVEL_LABEL[level]} name`}
            aria-invalid={nameTaken}
            className={`w-full bg-transparent text-text-primary p-2 border rounded ${nameTaken ? "outline-none focus:border-red-500 border-red-500" : `border-border ${INPUT_FOCUS}`} ${INPUT_COARSE}`}
          />
        </div>
      )}
      {nameTaken && (
        <p className="mt-1.5 text-xs text-signal-red">
          A {noun} named {finalName} already exists
        </p>
      )}

      <div className="mt-3 flex items-center gap-3">
        <div className="hidden flex-1 flex-wrap gap-x-2.5 gap-y-1 text-[10px] text-text-secondary sm:flex" aria-hidden="true">
          <span>
            <kbd className={HINT_KBD_CLASS}>⇥</kbd> level
          </span>
          <span>
            <kbd className={HINT_KBD_CLASS}>↑↓</kbd> folder
          </span>
          {hasName && (
            <span>
              <kbd className={HINT_KBD_CLASS}>⌘↵</kbd> name it…
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={submit}
          disabled={!nameValid}
          className={`w-full sm:w-auto sm:px-4 ${controlClass({ variant: "wide", disabled: !nameValid })}`}
        >
          Create {noun} ↵
        </button>
      </div>
    </Dialog>
  );
}
