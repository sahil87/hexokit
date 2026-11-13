import { describe, expect, it } from "vitest";
import { describeDeliver, describeSchedule, humanizeDuration } from "./cron-schedule";

describe("humanizeDuration", () => {
  it.each([
    ["60s", "1 minute"],
    ["1s", "1 second"],
    ["45s", "45 seconds"],
    ["30m", "30 minutes"],
    ["1m", "1 minute"],
    ["1h", "1 hour"],
    ["2h", "2 hours"],
    ["90m", "1 hour 30 minutes"],
    ["1h30m", "1 hour 30 minutes"],
    ["90s", "1 minute 30 seconds"],
    ["24h", "24 hours"],
    ["500ms", "less than 1 second"],
    ["250us", "less than 1 second"],
  ])("humanizes %s as %s", (raw, expected) => {
    expect(humanizeDuration(raw)).toBe(expected);
  });

  it("passes unparseable input through verbatim", () => {
    expect(humanizeDuration("hourly")).toBe("hourly");
    expect(humanizeDuration("")).toBe("");
  });
});

describe("describeSchedule", () => {
  it("words the operator-loop ladder around tracked items, not agent activity", () => {
    expect(
      describeSchedule({
        run: "operator-loop",
        schedule: { kind: "backoff", min: "3m", max: "24m" },
        wakeOn: { event: "agent-state-change" },
      }),
    ).toBe(
      "checks tracked items, backing off from 3 minutes up to 24 minutes while nothing changes; wakes on agent-state-change",
    );
  });

  it('describes {kind:"every"} as "every {duration}"', () => {
    expect(describeSchedule({ schedule: { kind: "every", interval: "1h" } })).toBe("every hour");
    expect(describeSchedule({ schedule: { kind: "every", interval: "30m" } })).toBe(
      "every 30 minutes",
    );
    expect(describeSchedule({ schedule: { kind: "every", interval: "60s" } })).toBe(
      "every minute",
    );
  });

  it("describes a backoff schedule as a range since last activity", () => {
    expect(
      describeSchedule({ schedule: { kind: "backoff", min: "60s", max: "30m" } }),
    ).toBe("backs off from 1 minute up to 30 minutes since last activity");
  });

  it("describes a cron-kind entry as the raw expression", () => {
    expect(describeSchedule({ schedule: { kind: "cron", expr: "0 * * * *" } })).toBe(
      "0 * * * *",
    );
    expect(describeSchedule({ schedule: { kind: "cron" } })).toBe("cron expression");
  });

  it("includes wakeOn when present", () => {
    expect(
      describeSchedule({
        schedule: { kind: "every", interval: "1h" },
        wakeOn: { event: "session-change" },
      }),
    ).toBe("every hour; wakes on session-change");
  });

  it("renders an unknown kind without fabricating a phrasing", () => {
    expect(describeSchedule({ schedule: { kind: "weird" } })).toBe("unknown schedule (weird)");
  });
});

describe("describeDeliver", () => {
  it("describes absent/empty/immediate as delivered immediately", () => {
    expect(describeDeliver(undefined)).toBe("delivered immediately");
    expect(describeDeliver("")).toBe("delivered immediately");
    expect(describeDeliver("immediate")).toBe("delivered immediately");
  });

  it("describes when-idle as held until idle, bounded by the hold window", () => {
    expect(describeDeliver("when-idle")).toBe("held until the agent is idle (up to 2h)");
  });

  it("describes skip-if-busy as skipped when busy", () => {
    expect(describeDeliver("skip-if-busy")).toBe("skipped when the agent is busy");
  });

  it("passes an unknown value through verbatim", () => {
    expect(describeDeliver("weird")).toBe("weird");
  });
});
