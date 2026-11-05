/**
 * Pure builder for the command-palette `ChatGPT connector:` action family
 * (docs/specs/openai-mcp.md § Palette; Constitution V). The caller supplies
 * the bodies (the settings POST and the restart route) and the live status.
 *
 *  - `ChatGPT connector: Turn on`: listed while off.
 *  - `ChatGPT connector: Turn off`: listed while on. No confirm: stopping
 *    loses nothing.
 *  - `ChatGPT connector: Restart`: listed while on, configured, and not
 *    mid-install.
 *
 * Before the first status event nothing is listed: an unknown status must
 * never offer a verb that contradicts the real one.
 */
import type { PaletteAction } from "@/components/command-palette";
import type { OpenAIMCPSignal } from "@/contexts/session-context";

export type OpenAIMCPPaletteInput = {
  signal: OpenAIMCPSignal | null;
  onTurnOn: () => void;
  onTurnOff: () => void;
  onRestart: () => void;
};

export function buildOpenAIMCPActions(input: OpenAIMCPPaletteInput): PaletteAction[] {
  const { signal } = input;
  if (signal === null) return [];
  if (!signal.enabled) {
    return [{ id: "openai-mcp-turn-on", label: "ChatGPT connector: Turn on", onSelect: input.onTurnOn }];
  }
  const actions: PaletteAction[] = [
    { id: "openai-mcp-turn-off", label: "ChatGPT connector: Turn off", onSelect: input.onTurnOff },
  ];
  const configured = signal.tunnelIdSet && signal.keySet;
  if (configured && signal.state !== "installing" && signal.state !== "unconfigured") {
    actions.push({ id: "openai-mcp-restart", label: "ChatGPT connector: Restart", onSelect: input.onRestart });
  }
  return actions;
}
