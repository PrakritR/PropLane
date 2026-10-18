import { describe, expect, it } from "vitest";
import {
  HOUSE_INFO_SECTIONS,
  containsHouseSecret,
  emptyHouseInfo,
  houseInfoEscalateAfter,
  houseInfoQuietWindow,
  houseInfoRenderSections,
  houseInfoSecretValues,
  normalizeHouseInfo,
  setHouseInfoValue,
} from "@/lib/house-info";
import { buildHousePublicPage, housePrivateValues } from "@/lib/house-printables/model";

function filled() {
  let i = emptyHouseInfo();
  i = setHouseInfoValue(i, "access", "doorCode", "4821");
  i = setHouseInfoValue(i, "access", "gateCode", "#9988");
  i = setHouseInfoValue(i, "access", "keyPickup", "Lockbox 7777");
  i = setHouseInfoValue(i, "access", "parking", "Street parking");
  i = setHouseInfoValue(i, "wifi", "network", "BrooklynNet");
  i = setHouseInfoValue(i, "wifi", "password", "Sunset-Maple-9");
  i = setHouseInfoValue(i, "safety", "alarm", "Panel 5555");
  i = setHouseInfoValue(i, "trash", "day", "Tuesday");
  i = setHouseInfoValue(i, "trash", "recycling", "Wednesday");
  i = setHouseInfoValue(i, "contacts", "manager", "Text PropLane");
  i = setHouseInfoValue(i, "rules", "quietFrom", "22:00");
  i = setHouseInfoValue(i, "rules", "quietTo", "08:00");
  i = setHouseInfoValue(i, "rules", "escalateAfter", "3");
  return i;
}

describe("house facts editor fields", () => {
  it("adds recycling day, manager contact and the complaint threshold", () => {
    const keys = (id: string) => HOUSE_INFO_SECTIONS.find((s) => s.id === id)!.fields.map((f) => f.key);
    expect(keys("trash")).toContain("recycling");
    expect(keys("contacts")).toContain("manager");
    expect(keys("rules")).toContain("escalateAfter");
  });

  it("normalizes a count to a whole number inside its bounds, or drops it", () => {
    const rules = (v: string) => normalizeHouseInfo({ rules: { escalateAfter: v } }).rules.escalateAfter;
    expect(rules("3")).toBe("3");
    expect(rules("99")).toBe("10");
    expect(rules("0")).toBe("1");
    expect(rules("lots")).toBeUndefined();
    expect(rules("2.5")).toBeUndefined();
  });

  it("round-trips the new fields through normalize", () => {
    const info = normalizeHouseInfo(filled());
    expect(info.trash.recycling).toBe("Wednesday");
    expect(info.contacts.manager).toBe("Text PropLane");
    expect(houseInfoEscalateAfter(info)).toBe(3);
    expect(houseInfoQuietWindow(info)).toEqual({ from: "22:00", to: "08:00" });
    expect(houseInfoEscalateAfter(emptyHouseInfo())).toBeNull();
  });
});

describe("secrets", () => {
  it("lists the door and gate codes, lockbox, Wi-Fi password and alarm", () => {
    expect(houseInfoSecretValues(filled()).sort()).toEqual(["#9988", "4821", "Lockbox 7777", "Panel 5555", "Sunset-Maple-9"].sort());
  });
  it("finds a secret in a text, spaced or cased differently, and not in an innocent one", () => {
    const info = filled();
    expect(containsHouseSecret("door code is 4821", info)).toBe(true);
    expect(containsHouseSecret("SUNSET maple-9", info)).toBe(true);
    expect(containsHouseSecret("see you at 5:30", info)).toBe(false);
    expect(containsHouseSecret("anything", emptyHouseInfo())).toBe(false);
  });
  it("matches a very short secret only as a whole token", () => {
    let i = emptyHouseInfo();
    i = setHouseInfoValue(i, "access", "doorCode", "42");
    expect(containsHouseSecret("code 42 today", i)).toBe(true);
    expect(containsHouseSecret("we have 142 rooms", i)).toBe(false);
  });
});

describe("what a resident, the public page and the printables may read", () => {
  it("never draws the complaint threshold to a resident", () => {
    const rows = houseInfoRenderSections(filled()).flatMap((s) => s.rows.map((r) => r.label));
    expect(rows).not.toContain("Escalate after complaints in 30 days");
    expect(rows).toContain("Recycling day");
  });

  it("keeps secrets and the threshold off the public page and door card", () => {
    const page = buildHousePublicPage({
      buildingName: "5259 Brooklyn",
      address: "5259 Brooklyn Ave NE",
      city: "Seattle",
      state: "WA",
      zip: "98105",
      houseInfo: filled(),
    } as never);
    const everything = JSON.stringify(page);
    for (const secret of houseInfoSecretValues(filled())) expect(everything).not.toContain(secret);
    expect(everything).not.toMatch(/Escalate after/);
    expect(page.trash.map((l) => l.label)).toContain("Recycling day");
    expect(page.rules.map((l) => l.label)).not.toContain("Escalate after complaints in 30 days");
    expect(housePrivateValues({ houseInfo: filled() } as never)).toContain("4821");
  });
});
