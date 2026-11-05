import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import type { OpenAIMCPSignal } from "@/contexts/session-context";

let signal: OpenAIMCPSignal | null = null;
vi.mock("@/contexts/session-context", () => ({
  useOpenAIMCP: () => signal,
}));
vi.mock("@/api/client", () => ({
  saveOpenAIMCPKey: vi.fn(),
  restartOpenAIMCP: vi.fn(),
}));
import { saveOpenAIMCPKey, restartOpenAIMCP } from "@/api/client";
import { OpenAIMCPSettingsRows, type OpenAIMCPRegistry } from "./settings-openai-mcp";

const KEY = "sk-proj-abcdefghijklmnopqrstuvwxyz0123";

function fakeRegistry(values: Record<string, unknown>): OpenAIMCPRegistry & { commits: Array<[string, unknown]> } {
  const commits: Array<[string, unknown]> = [];
  return {
    commits,
    entries: [],
    settingValue: (key: string) => values[key],
    commitSetting: async (key: string, value: unknown) => {
      commits.push([key, value]);
      values[key] = value;
    },
  };
}

function status(over: Partial<OpenAIMCPSignal>): OpenAIMCPSignal {
  return { enabled: true, tunnelIdSet: true, keySet: true, state: "ready", detail: "", ...over };
}

beforeEach(() => {
  signal = null;
  vi.mocked(saveOpenAIMCPKey).mockReset();
  vi.mocked(restartOpenAIMCP).mockReset();
});
afterEach(cleanup);

describe("OpenAIMCPSettingsRows", () => {
  it("commits the switch and the tunnel ID through the registry", async () => {
    const registry = fakeRegistry({ "openai_mcp.enabled": false, "openai_mcp.tunnel_id": null });
    render(<OpenAIMCPSettingsRows registry={registry} />);

    fireEvent.click(screen.getByRole("switch", { name: "ChatGPT connector" }));
    await waitFor(() => expect(registry.commits).toContainEqual(["openai_mcp.enabled", true]));

    const tunnel = screen.getByLabelText("Tunnel ID");
    fireEvent.change(tunnel, { target: { value: "  tunnel_abc123  " } });
    fireEvent.blur(tunnel);
    await waitFor(() => expect(registry.commits).toContainEqual(["openai_mcp.tunnel_id", "tunnel_abc123"]));
  });

  it("clears a saved tunnel ID as null", async () => {
    const registry = fakeRegistry({ "openai_mcp.enabled": true, "openai_mcp.tunnel_id": "tunnel_abc123" });
    render(<OpenAIMCPSettingsRows registry={registry} />);
    const tunnel = screen.getByLabelText("Tunnel ID");
    expect((tunnel as HTMLInputElement).value).toBe("tunnel_abc123");
    fireEvent.change(tunnel, { target: { value: "" } });
    fireEvent.blur(tunnel);
    await waitFor(() => expect(registry.commits).toContainEqual(["openai_mcp.tunnel_id", null]));
  });

  it("shows a rejected tunnel ID inline", async () => {
    const registry = fakeRegistry({ "openai_mcp.enabled": true, "openai_mcp.tunnel_id": null });
    registry.commitSetting = async () => {
      throw new Error("openai_mcp.tunnel_id: tunnel ID must look like tunnel_…");
    };
    render(<OpenAIMCPSettingsRows registry={registry} />);
    const tunnel = screen.getByLabelText("Tunnel ID");
    fireEvent.change(tunnel, { target: { value: "nope" } });
    fireEvent.blur(tunnel);
    expect(await screen.findByText(/tunnel ID must look like tunnel_/)).toBeTruthy();
  });

  it("saves the key write-only and never prefills it", async () => {
    signal = status({ keySet: false, state: "unconfigured", detail: "save an API key" });
    vi.mocked(saveOpenAIMCPKey).mockResolvedValue({ keySet: true });
    render(<OpenAIMCPSettingsRows registry={fakeRegistry({ "openai_mcp.enabled": true })} />);

    const input = screen.getByLabelText("API key");
    expect(input.getAttribute("type")).toBe("password");
    expect((input as HTMLInputElement).value).toBe("");
    fireEvent.change(input, { target: { value: KEY } });
    fireEvent.click(screen.getByRole("button", { name: "Save key" }));

    await waitFor(() => expect(saveOpenAIMCPKey).toHaveBeenCalledWith(KEY));
    expect(await screen.findByText("Saved")).toBeTruthy();
    expect(screen.queryByDisplayValue(KEY)).toBeNull();
  });

  it("replaces and clears a saved key", async () => {
    signal = status({});
    vi.mocked(saveOpenAIMCPKey).mockResolvedValue({ keySet: false });
    render(<OpenAIMCPSettingsRows registry={fakeRegistry({ "openai_mcp.enabled": true })} />);

    expect(screen.getByText("Saved")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Replace key" }));
    expect(screen.getByLabelText("API key")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    fireEvent.click(screen.getByRole("button", { name: "Clear key" }));
    await waitFor(() => expect(saveOpenAIMCPKey).toHaveBeenCalledWith(""));
    expect(await screen.findByLabelText("API key")).toBeTruthy();
  });

  it("shows a rejected key inline and keeps the input", async () => {
    signal = status({ keySet: false });
    vi.mocked(saveOpenAIMCPKey).mockRejectedValue(new Error("API key must look like sk-…"));
    render(<OpenAIMCPSettingsRows registry={fakeRegistry({ "openai_mcp.enabled": true })} />);
    fireEvent.change(screen.getByLabelText("API key"), { target: { value: "bad" } });
    fireEvent.click(screen.getByRole("button", { name: "Save key" }));
    expect(await screen.findByText("API key must look like sk-…")).toBeTruthy();
    expect(screen.getByLabelText("API key")).toBeTruthy();
  });

  it("renders each status with its state attribute", () => {
    const cases: Array<[OpenAIMCPSignal, RegExp]> = [
      [status({ enabled: false, state: "off" }), /Off/],
      [status({ state: "unconfigured", detail: "set the tunnel ID" }), /Needs setup: set the tunnel ID/],
      [status({ state: "installing" }), /Installing tunnel-client/],
      [status({ state: "stopped" }), /Not running/],
      [status({ state: "starting" }), /Starting/],
      [status({ state: "ready" }), /Ready/],
      [status({ state: "degraded", detail: "startup catalog pending" }), /Degraded: startup catalog pending/],
    ];
    for (const [s, text] of cases) {
      signal = s;
      const { unmount } = render(<OpenAIMCPSettingsRows registry={fakeRegistry({ "openai_mcp.enabled": s.enabled })} />);
      const el = screen.getByTestId("settings-openai-mcp-status");
      expect(el.getAttribute("data-state")).toBe(s.state);
      expect(el.textContent).toMatch(text);
      unmount();
    }
  });

  it("links the Platform tunnels page while unconfigured", () => {
    signal = status({ state: "unconfigured", tunnelIdSet: false, detail: "set the tunnel ID" });
    render(<OpenAIMCPSettingsRows registry={fakeRegistry({ "openai_mcp.enabled": true })} />);
    const link = screen.getByRole("link", { name: /Create a tunnel/ });
    expect(link.getAttribute("href")).toBe("https://platform.openai.com/settings/organization/tunnels");
  });

  it("offers Restart when running or stuck, and posts it", async () => {
    signal = status({ state: "degraded", detail: "x" });
    vi.mocked(restartOpenAIMCP).mockResolvedValue({ ok: true });
    render(<OpenAIMCPSettingsRows registry={fakeRegistry({ "openai_mcp.enabled": true })} />);
    fireEvent.click(screen.getByRole("button", { name: "Restart" }));
    await waitFor(() => expect(restartOpenAIMCP).toHaveBeenCalledTimes(1));
  });

  it("ignores a second Restart click while one is in flight", async () => {
    signal = status({ state: "stopped" });
    let resolve: (v: { ok: true }) => void = () => {};
    vi.mocked(restartOpenAIMCP).mockReturnValue(new Promise((r) => { resolve = r; }));
    render(<OpenAIMCPSettingsRows registry={fakeRegistry({ "openai_mcp.enabled": true })} />);
    const button = screen.getByRole("button", { name: "Restart" });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(restartOpenAIMCP).toHaveBeenCalledTimes(1);
    resolve({ ok: true });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
  });

  it("says so when the daemon answers that the connector is off", async () => {
    signal = status({ state: "stopped" });
    vi.mocked(restartOpenAIMCP).mockResolvedValue({ ok: false, off: true });
    render(<OpenAIMCPSettingsRows registry={fakeRegistry({ "openai_mcp.enabled": true })} />);
    fireEvent.click(screen.getByRole("button", { name: "Restart" }));
    expect(await screen.findByText("The connector is off")).toBeTruthy();
  });

  it("offers no Restart while off or unconfigured", () => {
    for (const s of [status({ enabled: false, state: "off" }), status({ state: "unconfigured", detail: "x" })]) {
      signal = s;
      const { unmount } = render(<OpenAIMCPSettingsRows registry={fakeRegistry({ "openai_mcp.enabled": s.enabled })} />);
      expect(screen.queryByRole("button", { name: "Restart" })).toBeNull();
      unmount();
    }
  });
});
