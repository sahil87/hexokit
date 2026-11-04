import { TabIdentity } from './tab';

// 15 s bounds web add / notify (the verbs bound their own tmux calls plus a port probe);
// 20 s bounds mux send (paste + probe + post-Enter observation).
export const WEB_ADD_TIMEOUT_MS = 15000;
export const NOTIFY_TIMEOUT_MS = 15000;
export const SEND_TIMEOUT_MS = 20000;

export function buildWebAddArgv(identity: TabIdentity, target: string): string[] {
  return ['tab', 'web', 'add', identity.tab, target, '--show', '-L', identity.server];
}

export function buildNotifyArgv(basename: string): string[] {
  return ['notify', 'presenting ' + basename, '--title', 'HexoKit'];
}

export function buildSendArgv(identity: TabIdentity, opts: { force: boolean }): string[] {
  const argv = ['mux', 'send', identity.tab, '-', '--no-enter', '-L', identity.server];
  if (opts.force) argv.push('--force');
  return argv;
}

export interface LinePosition {
  line: number;
  character: number;
}

// Selection lines are 0-based positions in, 1-based line numbers out; an end at column 0
// of a later line excludes that line.
export function selectionLines(
  start: LinePosition,
  end: LinePosition,
): { startLine: number; endLine: number } {
  const lastLine = end.character === 0 && end.line > start.line ? end.line - 1 : end.line;
  return { startLine: start.line + 1, endLine: lastLine + 1 };
}

export function formatReference(relPath: string, startLine: number, endLine: number): string {
  return startLine === endLine ? `${relPath}:${startLine}` : `${relPath}:${startLine}-${endLine}`;
}

// The payload is the reference line, a newline, then the text verbatim — no fences,
// no added trailing newline.
export function buildSendPayload(ref: string, text: string): string {
  return ref + '\n' + text;
}

export function parsePort(input: string): number | null {
  const trimmed = input.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const port = Number.parseInt(trimmed, 10);
  if (port < 1 || port > 65535) return null;
  return port;
}
