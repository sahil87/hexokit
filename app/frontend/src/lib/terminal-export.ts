/**
 * Pure helpers for the terminal tile export menu + palette actions
 * (260819-shqo-terminal-tile-export): filename building, buffer→text walks,
 * the HTML snapshot shell, and the one DOM edge (the Blob download trigger).
 *
 * The buffer helpers take a minimal STRUCTURAL shape so unit tests need no
 * real xterm `Terminal` — the tile layer passes `terminal.buffer.active`,
 * which satisfies it.
 *
 * The two-section menu split is load-bearing: the client buffer holds only
 * what streamed since attach, so for NORMAL-screen panes the honest "full
 * history" artifact comes from the server capture (tmux owns that scrollback)
 * — the client-side helpers here cover the "this view" arm. For ALT-screen
 * panes (agent TUIs) tmux holds no scrollback at all, so the server row is
 * gated off and the client buffer — sized by the `scrollback` mount option —
 * is the only transcript that exists.
 */

import { finalizeSafeName, toSafeWindowName } from "@/lib/names";

/** The actions the export menu + palette entries share (the one-CustomEvent
 *  seam: palette entries dispatch `EXPORT_EVENT` with `detail.action`, the
 *  SurfaceLayout export cluster listens — the `web-find:open` precedent). */
export type ExportAction = "snapshot" | "transcript" | "copy-visible" | "select" | "history";

export const EXPORT_EVENT = "terminal-export";

/** The minimal buffer-line surface the text walks read (structural — the
 *  xterm `IBufferLine` contract subset). */
export interface ExportBufferLine {
  translateToString(trimRight: boolean): string;
  isWrapped: boolean;
}

/** The minimal buffer surface (the xterm `IBuffer` contract subset). */
export interface ExportBuffer {
  length: number;
  getLine(index: number): ExportBufferLine | undefined;
}

/** `visibleScreenText` additionally needs the viewport's base offset. */
export interface ExportViewportBuffer extends ExportBuffer {
  viewportY: number;
}

/** `{session}-{window}-{YYMMDD-HHmmss}.{ext}` from the route context and the
 *  client clock; `full` appends `-full` before the extension (the server
 *  capture arm). Both name tokens are safe-name sanitized (the names.ts
 *  window rule — hyphens kept); an empty token falls back to `fallback`. */
export function buildExportFilename(
  session: string,
  windowName: string,
  date: Date,
  ext: "html" | "txt",
  full = false,
): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp =
    `${pad(date.getFullYear() % 100)}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  const clean = (raw: string) => finalizeSafeName(toSafeWindowName(raw));
  const sessionPart = clean(session) || "session";
  const windowPart = clean(windowName) || "window";
  return `${sessionPart}-${windowPart}-${stamp}${full ? "-full" : ""}.${ext}`;
}

/** Logical-line walk over a physical row range: a row whose SUCCESSOR carries
 *  `isWrapped` continues the same logical line (soft wrap), so the two join
 *  without a newline. Each physical row contributes
 *  `translateToString(true)` — trailing whitespace trimmed; no escape
 *  sequences (that is why this is a buffer walk, not `serialize()`). */
function textFromRange(buffer: ExportBuffer, start: number, end: number): string {
  const lines: string[] = [];
  let current = "";
  for (let i = start; i < end; i++) {
    current += buffer.getLine(i)?.translateToString(true) ?? "";
    const next = i + 1 < end ? buffer.getLine(i + 1) : undefined;
    if (next?.isWrapped) continue;
    lines.push(current);
    current = "";
  }
  if (current !== "") lines.push(current);
  return lines.join("\n");
}

/** The whole client buffer as plain text (transcript arm — wrapped-line
 *  aware, trailing whitespace trimmed per row). */
export function transcriptFromBuffer(buffer: ExportBuffer): string {
  return textFromRange(buffer, 0, buffer.length);
}

/** Exactly the visible viewport rows (`buffer.active.viewportY`, `rows`
 *  rows) as plain text — the copy-visible and select arms. */
export function visibleScreenText(buffer: ExportViewportBuffer, rows: number): string {
  return textFromRange(buffer, buffer.viewportY, buffer.viewportY + rows);
}

/** Select-sheet text: each line's trailing spaces dropped (TUIs pad rows to
 *  the pane width, which re-wraps badly in a narrower sheet) and trailing
 *  blank lines removed. */
export function trimSelectText(text: string): string {
  return text
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trimEnd();
}

/** Wrap `SerializeAddon.serializeAsHTML` output in a minimal standalone
 *  document (doctype, charset, title, monospace stack, dark terminal
 *  background) so the file opens self-contained in a browser. The title is
 *  HTML-escaped; `inner` is addon-generated markup and passes through
 *  verbatim. */
export function wrapHtmlSnapshot(inner: string, title: string): string {
  const escapedTitle = title
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return (
    `<!doctype html>\n<html><head><meta charset="utf-8">` +
    `<title>${escapedTitle}</title>` +
    `<style>html,body{margin:0;padding:8px;background:#1e1e1e;}` +
    `pre{margin:0;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;` +
    `font-size:13px;line-height:1.2;white-space:pre-wrap;}</style>` +
    `</head><body><pre>${inner}</pre></body></html>\n`
  );
}

/** The one DOM edge (the clipboard.ts precedent for a lib module with a DOM
 *  side): client-side download via a Blob + temporary `<a download>` anchor —
 *  no server round-trip. */
export function downloadTextFile(filename: string, mime: string, content: string): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
