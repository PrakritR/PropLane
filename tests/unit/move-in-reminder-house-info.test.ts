import { describe, expect, it } from "vitest";
import { buildMoveInReminderHtml, buildMoveInReminderText } from "@/lib/move-in-reminder-email";
import { emptyHouseInfo, setHouseInfoValue } from "@/lib/house-info";

function filledHouseInfo() {
  let info = setHouseInfoValue(emptyHouseInfo(), "access", "doorCode", "001000");
  info = setHouseInfoValue(info, "wifi", "network", "4709A");
  info = setHouseInfoValue(info, "wifi", "password", "4709A4709A$$");
  info = setHouseInfoValue(info, "trash", "day", "Tuesday");
  return { ...info, other: "Side gate sticks — lift and push." };
}

const base = {
  propertyLabel: "Alder Row",
  addressLine: "230 Alder Row, Seattle, WA 98144",
  moveInDateLabel: "Tuesday, September 22",
  instructions: null,
  generalHouseInfo: null,
};

describe("move-in reminder with structured house details", () => {
  it("sends labelled rows instead of a pasted paragraph", () => {
    const text = buildMoveInReminderText({ ...base, houseInfo: filledHouseInfo() });
    expect(text).toContain("Getting in:");
    expect(text).toContain("  Front door code: 001000");
    expect(text).toContain("  Password: 4709A4709A$$");
    expect(text).toContain("  Trash day: Tuesday");
    expect(text).toContain("Side gate sticks");
  });

  it("renders the same rows in the HTML body, escaped", () => {
    const html = buildMoveInReminderHtml({ ...base, houseInfo: filledHouseInfo() });
    expect(html).toContain("<strong>Getting in:</strong>");
    expect(html).toContain("001000");
    expect(html).toContain("4709A4709A$$");
    // `&` in an address or note must not break the markup.
    const withAmp = buildMoveInReminderHtml({
      ...base,
      houseInfo: setHouseInfoValue(emptyHouseInfo(), "wifi", "notes", "Guest & printer"),
    });
    expect(withAmp).toContain("Guest &amp; printer");
    expect(withAmp).not.toContain("Guest & printer");
  });

  it("falls back to the free text for a property nobody migrated", () => {
    const text = buildMoveInReminderText({ ...base, generalHouseInfo: "Front door code: 001000", houseInfo: null });
    expect(text).toContain("House info:");
    expect(text).toContain("Front door code: 001000");

    const html = buildMoveInReminderHtml({ ...base, generalHouseInfo: "Front door code: 001000", houseInfo: null });
    expect(html).toContain("<strong>House info:</strong>");
  });

  it("says nothing about the house when there is nothing to say", () => {
    const html = buildMoveInReminderHtml({ ...base, houseInfo: emptyHouseInfo() });
    expect(html).not.toContain("House info");
    expect(html).not.toContain("Getting in");
  });
});
