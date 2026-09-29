import { describe, it, expect, vi, afterEach } from "vitest";
import {
  HELP_TOPICS,
  HELP_TOPIC_EVENT,
  helpTopicActionId,
  helpTopicPaletteLabel,
  isHelpTopic,
  openHelpTopic,
} from "./help-topics";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("HELP_TOPICS registry", () => {
  it("lists the seven curated topics in display order", () => {
    expect(HELP_TOPICS.map((t) => t.id)).toEqual([
      "status-dot",
      "cron-schedule-kinds",
      "boards",
      "notifications",
      "gui",
      "merge-topologies",
      "fkf",
    ]);
  });

  it("has unique ids", () => {
    const ids = HELP_TOPICS.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("points every topic at an absolute hexokit.com page", () => {
    for (const t of HELP_TOPICS) {
      expect(t.url.startsWith("https://hexokit.com/")).toBe(true);
    }
  });

  it("gives every topic a non-empty label", () => {
    for (const t of HELP_TOPICS) {
      expect(t.label.trim()).not.toBe("");
    }
  });

  it("tags the two fab-kit pages and the five run-kit pages by tool", () => {
    expect(HELP_TOPICS.filter((t) => t.tool === "fab-kit").map((t) => t.id)).toEqual([
      "merge-topologies",
      "fkf",
    ]);
    expect(HELP_TOPICS.filter((t) => t.tool === "run-kit")).toHaveLength(5);
  });
});

describe("derivations", () => {
  it("derives the palette action id as help-topic-<id>", () => {
    expect(helpTopicActionId(HELP_TOPICS[0])).toBe("help-topic-status-dot");
  });

  it("derives the palette label as Help: <label>", () => {
    expect(helpTopicPaletteLabel(HELP_TOPICS[0])).toBe("Help: Status dot legend");
  });

  it("isHelpTopic accepts registry entries and rejects foreign details", () => {
    expect(isHelpTopic(HELP_TOPICS[0])).toBe(true);
    expect(isHelpTopic(null)).toBe(false);
    expect(isHelpTopic({ id: "x", label: "y", url: "z", tool: "other" })).toBe(false);
    expect(isHelpTopic("status-dot")).toBe(false);
  });
});

describe("openHelpTopic", () => {
  const topic = HELP_TOPICS[1];

  it("falls back to a noopener browser tab when no listener cancels the event", () => {
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    openHelpTopic(topic);
    expect(open).toHaveBeenCalledExactlyOnceWith(topic.url, "_blank", "noopener,noreferrer");
  });

  it("dispatches a cancelable rk:help-topic window event carrying the topic", () => {
    vi.spyOn(window, "open").mockImplementation(() => null);
    const seen: Event[] = [];
    const listener = (e: Event) => {
      seen.push(e);
    };
    window.addEventListener(HELP_TOPIC_EVENT, listener);
    try {
      openHelpTopic(topic);
    } finally {
      window.removeEventListener(HELP_TOPIC_EVENT, listener);
    }
    expect(seen).toHaveLength(1);
    const ev = seen[0];
    expect(ev).toBeInstanceOf(CustomEvent);
    expect(ev.cancelable).toBe(true);
    expect(ev instanceof CustomEvent && ev.detail).toEqual(topic);
  });

  it("does not open a browser tab when a listener calls preventDefault()", () => {
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    const listener = (e: Event) => e.preventDefault();
    window.addEventListener(HELP_TOPIC_EVENT, listener);
    try {
      openHelpTopic(topic);
    } finally {
      window.removeEventListener(HELP_TOPIC_EVENT, listener);
    }
    expect(open).not.toHaveBeenCalled();
  });
});
