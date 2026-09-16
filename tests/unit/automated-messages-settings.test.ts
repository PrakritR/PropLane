import { describe, expect, it } from "vitest";
import {
  AUTOMATED_MESSAGE_CATALOG,
  applyAutomatedMessageSetting,
  automatedMessageCatalogForArea,
  automatedMessageKey,
  normalizeAutomatedMessageSettings,
} from "@/lib/automated-messages-settings";

describe("automated message settings", () => {
  const rendered = { subject: "WO-1 · Leaking faucet", text: "Default copy", smsText: "Default copy" };

  it("keeps only well-formed keys and defaults enabled to true", () => {
    const settings = normalizeAutomatedMessageSettings({
      "work_order:accepted:vendor": { template: { subject: "S", body: "B" } },
      "work_order:accepted:resident": { enabled: false },
      "garbage": { enabled: false },
      "work_order:accepted:everyone": { enabled: false },
    });
    expect(Object.keys(settings).sort()).toEqual(["work_order:accepted:resident", "work_order:accepted:vendor"]);
    expect(settings["work_order:accepted:vendor"]).toEqual({ enabled: true, template: { subject: "S", body: "B" } });
  });

  it("returns the default copy when there is no entry", () => {
    expect(applyAutomatedMessageSetting({}, { domain: "work_order", event: "accepted", audience: "vendor", rendered })).toBe(rendered);
    expect(applyAutomatedMessageSetting(null, { domain: "work_order", event: "accepted", audience: "vendor", rendered })).toBe(rendered);
  });

  it("returns null when the manager switched the message off for that audience only", () => {
    const settings = normalizeAutomatedMessageSettings({ [automatedMessageKey("work_order", "accepted", "resident")]: { enabled: false } });
    expect(applyAutomatedMessageSetting(settings, { domain: "work_order", event: "accepted", audience: "resident", rendered })).toBeNull();
    expect(applyAutomatedMessageSetting(settings, { domain: "work_order", event: "accepted", audience: "vendor", rendered })).toBe(rendered);
  });

  it("fills a manager-authored template from the event context", () => {
    const settings = normalizeAutomatedMessageSettings({
      "work_order:accepted:resident": { enabled: true, template: { subject: "{vendorName} is coming", body: "See you {whenLabel}" } },
    });
    expect(
      applyAutomatedMessageSetting(settings, {
        domain: "work_order",
        event: "accepted",
        audience: "resident",
        rendered,
        context: { vendorName: "Juniper", whenLabel: "Thu 10:00" },
      }),
    ).toEqual({ subject: "Juniper is coming", text: "See you Thu 10:00", smsText: "See you Thu 10:00" });
  });

  it("puts every catalog entry in exactly one settings area", () => {
    const areas = new Set(AUTOMATED_MESSAGE_CATALOG.map((entry) => entry.area));
    let total = 0;
    for (const area of areas) total += automatedMessageCatalogForArea(area).length;
    expect(total).toBe(AUTOMATED_MESSAGE_CATALOG.length);
    expect(automatedMessageCatalogForArea("services").some((entry) => entry.event === "completed")).toBe(true);
  });
});
