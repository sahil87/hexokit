import { describe, it, expect, vi } from "vitest";
import { buildOpenAIMCPActions } from "./openai-mcp";
import type { OpenAIMCPSignal } from "@/contexts/session-context";

function signal(over: Partial<OpenAIMCPSignal>): OpenAIMCPSignal {
  return { enabled: true, tunnelIdSet: true, keySet: true, state: "ready", detail: "", ...over };
}

function ids(s: OpenAIMCPSignal | null) {
  return buildOpenAIMCPActions({ signal: s, onTurnOn: vi.fn(), onTurnOff: vi.fn(), onRestart: vi.fn() }).map((a) => a.id);
}

describe("buildOpenAIMCPActions", () => {
  it("offers nothing before the first status event", () => {
    expect(ids(null)).toEqual([]);
  });

  it("offers only Turn on while off", () => {
    expect(ids(signal({ enabled: false, state: "off" }))).toEqual(["openai-mcp-turn-on"]);
  });

  it("offers Turn off and Restart while on and configured", () => {
    for (const state of ["ready", "degraded", "stopped", "starting"] as const) {
      expect(ids(signal({ state }))).toEqual(["openai-mcp-turn-off", "openai-mcp-restart"]);
    }
  });

  it("offers no Restart while unconfigured or installing", () => {
    expect(ids(signal({ state: "unconfigured", keySet: false }))).toEqual(["openai-mcp-turn-off"]);
    expect(ids(signal({ state: "installing" }))).toEqual(["openai-mcp-turn-off"]);
  });

  it("labels the family and routes each row to its callback", () => {
    const onTurnOn = vi.fn();
    const onTurnOff = vi.fn();
    const onRestart = vi.fn();
    const off = buildOpenAIMCPActions({ signal: signal({ enabled: false, state: "off" }), onTurnOn, onTurnOff, onRestart });
    expect(off[0].label).toBe("ChatGPT connector: Turn on");
    off[0].onSelect();
    expect(onTurnOn).toHaveBeenCalledTimes(1);

    const on = buildOpenAIMCPActions({ signal: signal({}), onTurnOn, onTurnOff, onRestart });
    expect(on.map((a) => a.label)).toEqual(["ChatGPT connector: Turn off", "ChatGPT connector: Restart"]);
    on[0].onSelect();
    on[1].onSelect();
    expect(onTurnOff).toHaveBeenCalledTimes(1);
    expect(onRestart).toHaveBeenCalledTimes(1);
  });
});
