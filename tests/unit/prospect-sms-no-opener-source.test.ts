import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("prospect-facing SMS sources carry no PropLane opener and no STOP footer", () => {
  it("sms-relay direct-line intro", () => {
    const src = readFileSync("src/lib/sms-relay.server.ts", "utf8");
    const intro = src.slice(src.indexOf('"intro_counterparty",\n'), src.indexOf('"intro_manager",\n'));
    expect(intro).toContain("direct line");
    expect(intro).not.toMatch(/PropLane:|Reply STOP|HELP for help/);
  });
  it("tour notification texts to prospects", () => {
    const src = readFileSync("src/lib/tour-notification-delivery.server.ts", "utf8");
    expect(src).not.toMatch(/Reply STOP|HELP for help/);
    expect(src.match(/`PropLane: /g)).toHaveLength(1); // the one manager-facing alert
  });
});
