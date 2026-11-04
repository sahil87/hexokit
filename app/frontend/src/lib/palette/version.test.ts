import { describe, it, expect, vi } from "vitest";
import { displayVersion, buildVersionAction } from "./version";

describe("displayVersion", () => {
  it("prefixes a numeric version with v", () => {
    expect(displayVersion("0.6.2")).toBe("v0.6.2");
  });

  it("leaves the dev sentinel bare (no vdev)", () => {
    expect(displayVersion("dev")).toBe("dev");
  });

  it("is idempotent on an already-v-prefixed version (no vv)", () => {
    expect(displayVersion("v0.6.2")).toBe("v0.6.2");
  });
});

describe("buildVersionAction", () => {
  it("returns no action when version is null (no version event yet)", () => {
    expect(buildVersionAction(null, vi.fn())).toEqual([]);
  });

  it("builds a single action with the displayed numeric version in the label", () => {
    const action = buildVersionAction("0.6.2", vi.fn());
    expect(action).toHaveLength(1);
    expect(action[0].id).toBe("run-kit-version");
    expect(action[0].label).toBe("HexoKit: Version — v0.6.2");
  });

  it("shows the dev sentinel bare in the label (display-only, not dev-gated)", () => {
    const action = buildVersionAction("dev", vi.fn());
    expect(action).toHaveLength(1);
    expect(action[0].label).toBe("HexoKit: Version — dev");
  });

  it("wires the action to the supplied onSelect", () => {
    const onSelect = vi.fn();
    const [action] = buildVersionAction("0.6.2", onSelect);
    action.onSelect();
    expect(onSelect).toHaveBeenCalledTimes(1);
  });
});
