import { describe, expect, it } from "vitest";
import { AUTOMATED_MESSAGE_CATALOG } from "@/lib/automated-messages-settings";
import { automatedMessageDefaults } from "@/lib/automated-messages-defaults.server";

describe("automatedMessageDefaults: WS5 team rows have real preview copy", () => {
  it("renders a non-empty default for every team-audience catalog row", () => {
    const defaults = automatedMessageDefaults();
    const teamRows = AUTOMATED_MESSAGE_CATALOG.filter((entry) => entry.audiences.includes("team"));
    expect(teamRows.length).toBeGreaterThan(0);
    for (const entry of teamRows) {
      const key = `${entry.domain}:${entry.event}:team`;
      const rendered = defaults[key];
      expect(rendered, `missing default preview for ${key}`).toBeDefined();
      expect(rendered!.subject.trim().length).toBeGreaterThan(0);
      expect(rendered!.body.trim().length).toBeGreaterThan(0);
    }
    expect(teamRows.map((e) => `${e.domain}:${e.event}`).sort()).toEqual(
      [
        "application:application_approved",
        "application:application_declined",
        "availability:changed",
        "lease:lease_sent",
        "payment:payment_received",
        "tour:claimed",
        "tour:confirmed",
        "work_order:accepted",
        "work_order:completed",
      ].sort(),
    );
  });
});
