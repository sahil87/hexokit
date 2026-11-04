/**
 * The one data table — a headless TanStack Table model rendered in the
 * project's own Tailwind/Control vocabulary, mounted by `watched-table.tsx`
 * (Operator Tasks / the Server page WATCHED zone), `cron-list.tsx`, and
 * `cron-log.tsx`. The component owns the table chrome — the header row with
 * `aria-sort` sort buttons, the fine-pointer-only resize handles, the
 * `<colgroup>` widths, the per-viewer `hexokit-table-<id>` view-state store,
 * and the mounted-table registry behind the palette's `Table: Reset columns`;
 * consumers own their cells via per-column `cell(row)` renderers and per-row
 * `rowProps(row)`, plus the opt-in `cellClassName` (the Cron tabs' coarse-
 * pointer 44px row floor — applied to the cells, where min-height sizes the
 * row).
 *
 * Widths ride CSS custom properties (`--rk-col-<id>`) set on the `<table>`
 * and read by each `<col>`, so a resize drag restyles the table rather than
 * re-keying cells; the `<table>`'s `minWidth` is the summed column widths so
 * `table-fixed` never redistributes. The view-state store writes once on drag
 * end (pointer-up), never per move, and treats absent/corrupt/out-of-clamp
 * values as defaults. A cleared sort means the table's `initialSort`, never
 * raw input order. Resize is mouse-only by design (coarse pointers render no
 * handles); the palette reset is the keyboard path.
 */
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type HTMLAttributes,
  type ReactNode,
} from "react";
import {
  columnResizingFeature,
  columnSizingFeature,
  createSortedRowModel,
  rowSortingFeature,
  sortFns,
  tableFeatures,
  useTable,
  type ColumnDef,
  type ColumnSizingState,
  type SortingState,
} from "@tanstack/react-table";
import { Control } from "@/components/control";
import { useCoarsePointer } from "@/hooks/use-coarse-pointer";

/** localStorage key prefix; one JSON key per table (`hexokit-table-cron-list`). */
export const DATA_TABLE_STORAGE_PREFIX = "hexokit-table-";

export const DATA_TABLE_MIN_COL_PX = 48;
export const DATA_TABLE_MAX_COL_PX = 960;

/** The header button's resting typography — identical to the pre-DataTable
 *  `<th>` recipe, so a header is visually unchanged until sorted (the green
 *  latched arm) or hovered. Padding is appended per header (density variant,
 *  last column drops the right padding). */
const DATA_TABLE_HEADER_BASE =
  "text-left text-[10px] uppercase tracking-wide text-text-secondary font-normal w-full";

/** Resize handle hit width. */
const DATA_TABLE_HANDLE_PX = 6;

/** The table's v9 feature set (static, per `tableFeatures` guidance): sorting
 *  with the built-in `sortFns` registry behind `'auto'`, column sizing, and
 *  the resize handlers. The core row model is always created in v9; the
 *  sorted row model is explicit. */
const dataTableFeatures = tableFeatures({
  rowSortingFeature,
  columnSizingFeature,
  columnResizingFeature,
  sortedRowModel: createSortedRowModel(),
  sortFns,
});
type DataTableFeatures = typeof dataTableFeatures;

export type DataTableSort = { id: string; desc: boolean } | null;

export type DataTableViewState = {
  /** null = "use the table's initialSort". */
  sort: DataTableSort;
  /** Column id → px; columns absent here render at their default `size`. */
  widths: Record<string, number>;
};

export type DataTableColumn<Row> = {
  /** Stable column id — the sort/width persistence key. */
  id: string;
  /** The visible lowercase label. */
  header: string;
  /** Sort accessor: a scalar, or undefined (sorts last in both directions). */
  sortValue: (row: Row) => string | number | undefined;
  /** Optional comparator overriding the default scalar compare. */
  sortingFn?: (a: Row, b: Row) => number;
  /** Undefined-value placement; default "last" in both directions. Set `false`
   *  when `sortingFn` handles undefined itself (the Cron List's `next` column,
   *  whose comparator owns the undated-last + label/id tie-break — TanStack
   *  skips the custom sort fn entirely for both-undefined pairs otherwise). */
  sortUndefined?: false | -1 | 1 | "first" | "last";
  cell: (row: Row) => ReactNode;
  /** Default width in px. */
  size: number;
  minSize?: number;
  maxSize?: number;
  /** Extra classes on that column's `<td>`s (alignment, ink) — a string, or a
   *  per-row callback for row-conditional cell treatments (the stale-note dim,
   *  the waiting amber). */
  className?: string | ((row: Row) => string | undefined);
};

/** The sizing slice of a column, as the view-state reader needs it. */
export type DataTableColumnSizing = Pick<
  DataTableColumn<unknown>,
  "id" | "size" | "minSize" | "maxSize"
>;

export type DataTableRowProps = Pick<
  HTMLAttributes<HTMLTableRowElement>,
  "className" | "onClick" | "onKeyDown" | "role" | "tabIndex" | "aria-disabled"
> & { "data-testid"?: string; "data-done"?: string };

// ── Per-viewer view-state store (Constitution IV — localStorage) ────────────
//
// In-module pub/sub keyed on the storage key, after
// `hooks/use-local-storage-enum.ts` (the native `storage` event fires only
// across tabs, so same-tab co-mounted tables — the drawer and the Server
// page — need the dispatch). Value discipline after `lib/quake-terminal.ts`:
// JSON in try/catch, per-field validation and clamping, anything unusable
// resolving to defaults without error.

const viewStateSubscribers = new Map<string, Set<() => void>>();

function notifyViewState(storageKey: string): void {
  const listeners = viewStateSubscribers.get(storageKey);
  if (!listeners) return;
  for (const listener of listeners) listener();
}

function subscribeViewState(storageKey: string, listener: () => void): () => void {
  let listeners = viewStateSubscribers.get(storageKey);
  if (!listeners) {
    listeners = new Set();
    viewStateSubscribers.set(storageKey, listeners);
  }
  listeners.add(listener);
  return () => {
    const set = viewStateSubscribers.get(storageKey);
    if (!set) return;
    set.delete(listener);
    if (set.size === 0) viewStateSubscribers.delete(storageKey);
  };
}

function viewStateKey(tableId: string): string {
  return `${DATA_TABLE_STORAGE_PREFIX}${tableId}`;
}

function columnMin(column: DataTableColumnSizing): number {
  return column.minSize ?? DATA_TABLE_MIN_COL_PX;
}

function columnMax(column: DataTableColumnSizing): number {
  return column.maxSize ?? DATA_TABLE_MAX_COL_PX;
}

function clampColumnWidth(column: DataTableColumnSizing, width: number): number {
  return Math.min(columnMax(column), Math.max(columnMin(column), Math.round(width)));
}

/** Read the stored view state: a `sort` naming an unknown column degrades to
 *  null; widths must be finite numbers, clamp into their column's
 *  `[minSize, maxSize]`, and unknown column ids drop. A throwing localStorage
 *  (privacy mode) reads as empty. */
export function readDataTableViewState(
  tableId: string,
  columns: DataTableColumnSizing[],
): DataTableViewState {
  const defaults: DataTableViewState = { sort: null, widths: {} };
  try {
    const raw = localStorage.getItem(viewStateKey(tableId));
    if (raw == null) return defaults;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return defaults;
    const bag = parsed as Record<string, unknown>;

    let sort: DataTableSort = null;
    const rawSort = bag.sort;
    if (typeof rawSort === "object" && rawSort !== null) {
      const sortBag = rawSort as Record<string, unknown>;
      if (
        typeof sortBag.id === "string" &&
        typeof sortBag.desc === "boolean" &&
        columns.some((column) => column.id === sortBag.id)
      ) {
        sort = { id: sortBag.id, desc: sortBag.desc };
      }
    }

    const widths: Record<string, number> = {};
    const rawWidths = bag.widths;
    if (typeof rawWidths === "object" && rawWidths !== null) {
      const widthBag = rawWidths as Record<string, unknown>;
      for (const column of columns) {
        const value = widthBag[column.id];
        if (typeof value === "number" && Number.isFinite(value)) {
          widths[column.id] = clampColumnWidth(column, value);
        }
      }
    }
    return { sort, widths };
  } catch {
    // localStorage unavailable or corrupt JSON
    return defaults;
  }
}

/** Persist the whole view state (sort + widths) and notify subscribers. A
 *  throwing localStorage is ignored — the in-tab subscribers still update. */
export function writeDataTableViewState(tableId: string, state: DataTableViewState): void {
  try {
    localStorage.setItem(viewStateKey(tableId), JSON.stringify(state));
  } catch {
    // localStorage unavailable
  }
  notifyViewState(viewStateKey(tableId));
}

/** Clear the table's key (sort back to `initialSort`, widths back to `size`)
 *  and notify subscribers. */
export function resetDataTableViewState(tableId: string): void {
  try {
    localStorage.removeItem(viewStateKey(tableId));
  } catch {
    // localStorage unavailable
  }
  notifyViewState(viewStateKey(tableId));
}

/** The table's persisted view state plus bound writers, `[state, {write,
 *  reset}]` like the other localStorage hooks. Same-tab co-mounts stay in
 *  sync via the pub/sub; cross-tab rides the native `storage` event. */
export function useDataTableViewState(
  tableId: string,
  columns: DataTableColumnSizing[],
): [DataTableViewState, { write: (state: DataTableViewState) => void; reset: () => void }] {
  const [value, setValue] = useState<DataTableViewState>(() =>
    readDataTableViewState(tableId, columns),
  );
  const columnsRef = useRef(columns);
  columnsRef.current = columns;

  useEffect(() => {
    const key = viewStateKey(tableId);
    const reread = () => setValue(readDataTableViewState(tableId, columnsRef.current));
    const unsubscribe = subscribeViewState(key, reread);
    const onStorage = (event: StorageEvent) => {
      if (event.key === key) reread();
    };
    if (typeof window !== "undefined") {
      window.addEventListener("storage", onStorage);
    }
    // Resync in case another subscriber wrote between render and effect.
    reread();
    return () => {
      unsubscribe();
      if (typeof window !== "undefined") {
        window.removeEventListener("storage", onStorage);
      }
    };
  }, [tableId]);

  const setters = useMemo(
    () => ({
      write: (state: DataTableViewState) => writeDataTableViewState(tableId, state),
      reset: () => resetDataTableViewState(tableId),
    }),
    [tableId],
  );
  return [value, setters];
}

// ── Mounted-table registry (the palette's `Table: Reset columns` source) ────

const mountedDataTables = new Map<string, string>();
const mountedListeners = new Set<() => void>();
let mountedSnapshot: { id: string; label: string }[] = [];

function refreshMountedSnapshot(): void {
  mountedSnapshot = [...mountedDataTables.entries()]
    .map(([id, label]) => ({ id, label }))
    .sort((a, b) => a.id.localeCompare(b.id));
  for (const listener of mountedListeners) listener();
}

/** Register a mounted table; the returned cleanup unregisters only its own
 *  registration. */
export function registerMountedDataTable(tableId: string, label: string): () => void {
  mountedDataTables.set(tableId, label);
  refreshMountedSnapshot();
  return () => {
    if (mountedDataTables.get(tableId) === label) {
      mountedDataTables.delete(tableId);
      refreshMountedSnapshot();
    }
  };
}

function subscribeMounted(listener: () => void): () => void {
  mountedListeners.add(listener);
  return () => {
    mountedListeners.delete(listener);
  };
}

function getMountedSnapshot(): { id: string; label: string }[] {
  return mountedSnapshot;
}

/** The currently mounted tables, live — the palette builder's input. */
export function useMountedDataTables(): { id: string; label: string }[] {
  return useSyncExternalStore(subscribeMounted, getMountedSnapshot);
}

// ── The component ────────────────────────────────────────────────────────────

export type DataTableProps<Row extends object> = {
  /** Storage + palette identity ("watched", "watched-dense", "cron-list", …). */
  tableId: string;
  /** Display name in the palette's reset picker. */
  label: string;
  columns: DataTableColumn<Row>[];
  rows: Row[];
  rowKey: (row: Row) => string;
  /** The at-rest order when the viewer has no persisted sort (null = input
   *  order). A cleared user sort returns here. */
  initialSort: DataTableSort;
  /** Quake drawer variant: `pr-2 py-0.5` cells / `pr-2 pb-1` headers. */
  dense?: boolean;
  rowProps: (row: Row) => DataTableRowProps;
  /** Extra classes on every `<td>` — the consumers' coarse-pointer row-height
   *  floor (`coarse:min-h-[44px]` on the Cron tabs): a min-height on the
   *  `<tr>` does not reliably size the row, so the floor lands on the cells. */
  cellClassName?: string;
  /** Extra classes on the `<table>` (e.g. the stale `opacity-50`). */
  className?: string;
  "data-testid"?: string;
};

export function DataTable<Row extends object>({
  tableId,
  label,
  columns,
  rows,
  rowKey,
  initialSort,
  dense = false,
  rowProps,
  cellClassName,
  className,
  "data-testid": testId,
}: DataTableProps<Row>) {
  const coarse = useCoarsePointer();
  const [viewState, viewStore] = useDataTableViewState(tableId, columns);
  const viewStateRef = useRef(viewState);
  viewStateRef.current = viewState;

  useEffect(() => registerMountedDataTable(tableId, label), [tableId, label]);

  // The user sort is the only persisted sort; the effective sorting falls
  // back to `initialSort` so a cleared sort returns to the at-rest order.
  const effectiveSort = viewState.sort ?? initialSort;
  const sorting = useMemo<SortingState>(
    () => (effectiveSort ? [effectiveSort] : []),
    [effectiveSort],
  );

  const cycleSort = (columnId: string) => {
    const current = viewStateRef.current.sort;
    const next: DataTableSort =
      current?.id !== columnId
        ? { id: columnId, desc: false }
        : current.desc
          ? null
          : { id: columnId, desc: true };
    viewStore.write({ sort: next, widths: viewStateRef.current.widths });
  };

  // During a drag the live sizes sit in a local overlay so the store writes
  // once on pointer-up, never per move. The ref mirrors the overlay
  // synchronously — the drag-end listener reads it before React re-renders.
  const [dragSizing, setDragSizing] = useState<ColumnSizingState | null>(null);
  const dragSizingRef = useRef<ColumnSizingState | null>(null);
  const disarmDragEndRef = useRef<(() => void) | null>(null);

  // A mid-drag unmount (closing the drawer before pointer-up) must disarm the
  // document-level drag-end listeners — otherwise the survivor fires
  // setDragSizing/persistWidths for a dead table.
  useEffect(() => () => disarmDragEndRef.current?.(), []);

  const columnSizing = useMemo<ColumnSizingState>(
    () => ({ ...viewState.widths, ...(dragSizing ?? {}) }),
    [viewState.widths, dragSizing],
  );

  const persistWidths = (widths: ColumnSizingState) => {
    const clamped: Record<string, number> = {};
    for (const column of columns) {
      const px = widths[column.id];
      if (typeof px === "number" && Number.isFinite(px)) {
        clamped[column.id] = clampColumnWidth(column, px);
      }
    }
    viewStore.write({ sort: viewStateRef.current.sort, widths: clamped });
  };

  const armDragEnd = () => {
    disarmDragEndRef.current?.();
    const finish = () => {
      disarmDragEndRef.current?.();
      disarmDragEndRef.current = null;
      const sizing = dragSizingRef.current;
      dragSizingRef.current = null;
      setDragSizing(null);
      if (sizing) persistWidths(sizing);
    };
    document.addEventListener("mouseup", finish, { once: true });
    document.addEventListener("touchend", finish, { once: true });
    disarmDragEndRef.current = () => {
      document.removeEventListener("mouseup", finish);
      document.removeEventListener("touchend", finish);
    };
  };

  const resetColumnWidth = (columnId: string) => {
    const widths = { ...viewStateRef.current.widths };
    delete widths[columnId];
    viewStore.write({ sort: viewStateRef.current.sort, widths });
  };

  const tableColumns = useMemo<ColumnDef<DataTableFeatures, Row>[]>(
    () =>
      columns.map((column) => {
        const compare = column.sortingFn;
        return {
          id: column.id,
          accessorFn: column.sortValue,
          // v9 column keys: `sortFn` (v8's `sortingFn`) and a per-column
          // `sortUndefined` (no table-level option anymore).
          ...(compare
            ? { sortFn: (a: { original: Row }, b: { original: Row }) => compare(a.original, b.original) }
            : {}),
          sortUndefined: column.sortUndefined ?? ("last" as const),
          size: column.size,
          minSize: column.minSize ?? DATA_TABLE_MIN_COL_PX,
          maxSize: column.maxSize ?? DATA_TABLE_MAX_COL_PX,
        };
      }),
    [columns],
  );

  const table = useTable<DataTableFeatures, Row>({
    features: dataTableFeatures,
    data: rows,
    columns: tableColumns,
    state: { sorting, columnSizing },
    enableMultiSort: false,
    enableSortingRemoval: true,
    columnResizeMode: "onChange",
    columnResizeDirection: "ltr",
    enableColumnResizing: !coarse,
    onColumnSizingChange: (updater) => {
      const current = { ...viewStateRef.current.widths, ...(dragSizingRef.current ?? {}) };
      const next = typeof updater === "function" ? updater(current) : updater;
      dragSizingRef.current = next;
      setDragSizing(next);
    },
  });

  const leafColumns = table.getAllLeafColumns();
  const tableStyle: CSSProperties & Record<string, string | number> = { minWidth: 0 };
  let totalWidth = 0;
  for (const leaf of leafColumns) {
    const size = leaf.getSize();
    totalWidth += size;
    tableStyle[`--rk-col-${leaf.id}`] = `${size}px`;
  }
  // `table-fixed` redistributes spare width across the `<col>`s; the minWidth
  // floor keeps the summed widths from being squeezed below their clamps.
  tableStyle.minWidth = totalWidth;

  const cellPad = dense ? "pr-2 py-0.5" : "pr-3 py-1";
  const lastCellPad = dense ? "py-0.5" : "py-1";
  const headPad = dense ? "pr-2 pb-1" : "pr-3 pb-1";

  const headers = table.getFlatHeaders();
  const lastIndex = headers.length - 1;

  return (
    <div className="overflow-x-auto">
      <table
        className={`w-full text-xs font-mono table-fixed${className ? ` ${className}` : ""}`}
        style={tableStyle}
        data-testid={testId}
      >
        <colgroup>
          {leafColumns.map((leaf) => (
            <col key={leaf.id} style={{ width: `var(--rk-col-${leaf.id})` }} />
          ))}
        </colgroup>
        <thead>
          <tr>
            {headers.map((header, index) => {
              const sorted = effectiveSort?.id === header.column.id ? effectiveSort : null;
              return (
                <th
                  key={header.id}
                  scope="col"
                  aria-sort={sorted ? (sorted.desc ? "descending" : "ascending") : "none"}
                  className="relative"
                >
                  <Control
                    variant="toggle"
                    ringed
                    base={`${DATA_TABLE_HEADER_BASE} ${index === lastIndex ? "pb-1" : headPad}`}
                    pressed={sorted !== null}
                    aria-label={`Sort by ${columns[index]?.header ?? header.column.id}`}
                    onClick={() => cycleSort(header.column.id)}
                  >
                    {columns[index]?.header}
                    {sorted && (
                      <span aria-hidden="true" className="ml-1">
                        {sorted.desc ? "▾" : "▴"}
                      </span>
                    )}
                  </Control>
                  {!coarse && index < lastIndex && (
                    <div
                      aria-hidden="true"
                      data-testid="data-table-resize-handle"
                      onMouseDown={(event) => {
                        // TanStack's handler registers its document-level
                        // mouseup first, so its end-commit lands in
                        // `onColumnSizingChange` before our drag-end listener
                        // reads the sizing ref.
                        header.getResizeHandler()(event);
                        armDragEnd();
                      }}
                      onTouchStart={(event) => {
                        header.getResizeHandler()(event);
                        armDragEnd();
                      }}
                      onDoubleClick={() => resetColumnWidth(header.column.id)}
                      className={`absolute right-0 top-0 h-full cursor-col-resize touch-none select-none${
                        header.column.getIsResizing()
                          ? " bg-accent-green"
                          : " hover:bg-accent-green/60"
                      }`}
                      style={{ width: DATA_TABLE_HANDLE_PX }}
                    />
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {table.getRowModel().rows.map((row) => (
            <tr key={rowKey(row.original)} {...rowProps(row.original)}>
              {columns.map((column, index) => {
                const cellClass =
                  typeof column.className === "function" ? column.className(row.original) : column.className;
                return (
                  <td
                    key={column.id}
                    className={`${index === lastIndex ? lastCellPad : cellPad}${
                      cellClassName ? ` ${cellClassName}` : ""
                    }${cellClass ? ` ${cellClass}` : ""}`}
                  >
                    {column.cell(row.original)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
