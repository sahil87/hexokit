import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { Nameplate } from "./nameplate";

// jsdom has no layout: give the nameplate's measurement reads explicit widths
// so the right-to-left fold is observable. The root reports `rootWidth`; each
// field in the hidden measuring clone reports its natural width from this
// table, keyed by its text.
function stubLayout(rootWidth: number, widths: Record<string, number>, nameWidth = 50) {
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) {
    return this.getAttribute("data-testid") === "shell-nameplate" ? rootWidth : 0;
  });
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) {
    if (this.hasAttribute("data-np-name")) return nameWidth;
    if (this.hasAttribute("data-np-field")) {
      const text = this.textContent ?? "";
      const hit = Object.keys(widths).find((k) => text.includes(k));
      return hit ? widths[hit] : 0;
    }
    return 0;
  });
}

const data = {
  name: "ws-01",
  userMachine: "sahil@ws-01",
  os: "linux",
  kind: "net" as const,
  link: "tailscale",
  agents: 11,
};
const widths = { "sahil@ws-01": 100, linux: 60, tailscale: 70, "11 agents": 80 };

const shownKeys = () =>
  [...document.querySelectorAll("[data-np-shown]")].map((el) => el.getAttribute("data-np-shown"));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Nameplate", () => {
  it("shows the name and every field in order when there is room (and in an unmeasured jsdom)", () => {
    render(<Nameplate data={data} />);
    expect(screen.getByTestId("shell-nameplate-name")).toHaveTextContent("ws-01");
    expect(shownKeys()).toEqual(["userMachine", "os", "link", "agents"]);
  });

  it("folds right-to-left as the band narrows: agents, then link, then OS, then user@machine — never the name", () => {
    // name 50 + 4 separators (14 each) + 100 + 60 + 70 + 80 = 416 → all fit at 416.
    stubLayout(416, widths);
    render(<Nameplate data={data} />);
    expect(shownKeys()).toEqual(["userMachine", "os", "link", "agents"]);

    cleanup();
    stubLayout(415, widths);
    render(<Nameplate data={data} />);
    expect(shownKeys()).toEqual(["userMachine", "os", "link"]);

    cleanup();
    stubLayout(50 + 14 + 100 + 14 + 60 + 5, widths);
    render(<Nameplate data={data} />);
    expect(shownKeys()).toEqual(["userMachine", "os"]);

    cleanup();
    stubLayout(50 + 14 + 100 + 5, widths);
    render(<Nameplate data={data} />);
    expect(shownKeys()).toEqual(["userMachine"]);

    cleanup();
    stubLayout(60, widths);
    render(<Nameplate data={data} />);
    expect(shownKeys()).toEqual([]);
    expect(screen.getByTestId("shell-nameplate-name")).toHaveTextContent("ws-01");
  });

  it("labels the kind glyph for assistive tech and draws it before the OS text", () => {
    render(<Nameplate data={{ ...data, kind: "tunnel" }} />);
    const os = document.querySelector('[data-np-shown="os"]');
    expect(os?.querySelector('svg[role="img"]')).toHaveAttribute("aria-label", "rk remote · SSH tunnel");
    expect(os?.textContent).toBe("linux");
  });

  it("marks a hover preview with data-peek and the → prefix", () => {
    render(<Nameplate data={{ name: "lab" }} peek />);
    expect(screen.getByTestId("shell-nameplate")).toHaveAttribute("data-peek", "true");
    expect(screen.getByTestId("shell-nameplate-name").textContent).toBe("→ lab");
  });

  it("renders only the name for a host that reported nothing", () => {
    render(<Nameplate data={{ name: "lab" }} />);
    expect(shownKeys()).toEqual([]);
  });

  it("reports each layout pass so the strip can re-measure the light", () => {
    const onLayout = vi.fn();
    render(<Nameplate data={data} onLayout={onLayout} />);
    expect(onLayout).toHaveBeenCalled();
  });
});
