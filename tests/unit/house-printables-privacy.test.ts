// A QR taped to a front door is public forever. The page it opens, and the two
// printables that carry it, are built from an allowlist — the rules and trash
// sections — so a door code or a Wi-Fi password cannot reach them by any path.
import { describe, expect, it } from "vitest";
import { HOUSE_INFO_SECTIONS, normalizeHouseInfo, type HouseInfoV1 } from "@/lib/house-info";
import {
  HOUSE_PRIVATE_SECTIONS,
  HOUSE_PUBLIC_SECTIONS,
  buildHouseDoorCard,
  buildHousePublicPage,
  buildHouseWelcomeSheet,
  housePrivateValues,
  housePublicPageIsEmpty,
} from "@/lib/house-printables/model";
import { createDefaultListingSubmission, type ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";

/** Every field of every section filled with a value that names itself. */
function fullHouseInfo(): HouseInfoV1 {
  const raw: Record<string, Record<string, string>> = {};
  for (const spec of HOUSE_INFO_SECTIONS) {
    raw[spec.id] = {};
    for (const field of spec.fields) {
      if (field.kind === "timeRange" && field.pairKey) {
        raw[spec.id][field.key] = "23:00";
        raw[spec.id][field.pairKey] = "07:00";
      } else {
        raw[spec.id][field.key] = `SECRET-${spec.id}-${field.key}`;
      }
    }
  }
  return normalizeHouseInfo({ ...raw, other: "SECRET-other" });
}

function house(over: Partial<ManagerListingSubmissionV1> = {}): ManagerListingSubmissionV1 {
  return {
    ...createDefaultListingSubmission(),
    buildingName: "Ballard House",
    address: "5257 Brooklyn Ave NE",
    city: "Seattle",
    state: "WA",
    zip: "98105",
    houseInfo: fullHouseInfo(),
    rooms: [
      { ...createDefaultListingSubmission().rooms?.[0], id: "r6", name: "Room 6", floor: "Third floor", moveInInstructions: "SECRET-room-6-notes" } as ManagerListingSubmissionV1["rooms"][number],
    ],
    ...over,
  };
}

describe("the public/private split is total", () => {
  it("every section is on exactly one side", () => {
    const all = HOUSE_INFO_SECTIONS.map((s) => s.id).sort();
    expect([...HOUSE_PUBLIC_SECTIONS, ...HOUSE_PRIVATE_SECTIONS].sort()).toEqual(all);
  });

  it("the public page carries the rules and the trash days and not one private value", () => {
    const sub = house();
    const page = buildHousePublicPage(sub, { smsPhone: "+12065550142" });
    const rendered = JSON.stringify(page);
    for (const secret of housePrivateValues(sub)) expect(rendered).not.toContain(secret);
    expect(rendered).not.toContain("SECRET-other");
    expect(rendered).not.toContain("SECRET-room-6-notes");
    expect(page.quietHours).toBe("11 PM – 7 AM");
    expect(page.rules.map((l) => l.label)).toContain("Smoking");
    expect(page.rules.map((l) => l.label)).toContain("Kitchen & dining");
    expect(page.trash.map((l) => l.label)).toEqual(["Trash day", "Recycling & compost", "Professional cleaning"]);
    // The bin's location and the between-cleanings chores are for residents, not passers-by.
    expect(rendered).not.toContain("SECRET-trash-binLocation");
    expect(rendered).not.toContain("SECRET-trash-betweenCleanings");
    expect(page.smsPhone).toBe("+12065550142");
  });

  it("the door card has the address, the URL and the work number — nothing else", () => {
    const sub = house();
    const card = buildHouseDoorCard(sub, { url: "https://prop-lane.space/h/abc", smsPhone: "+12065550142" });
    const rendered = JSON.stringify(card);
    for (const secret of housePrivateValues(sub)) expect(rendered).not.toContain(secret);
    expect(card.name).toBe("Ballard House");
    expect(card.street).toBe("5257 Brooklyn Ave NE");
    expect(card.cityZip).toBe("Seattle, WA 98105");
    expect(card.url).toBe("https://prop-lane.space/h/abc");
  });

  it("the welcome sheet is the one that carries the codes, the Wi-Fi and the room's notes", () => {
    const sub = house();
    const sheet = buildHouseWelcomeSheet(sub, { portalUrl: "https://prop-lane.space/resident", roomId: "r6", residentName: " Maya " });
    expect(sheet.residentName).toBe("Maya");
    expect(sheet.roomLabel).toBe("Room 6");
    expect(sheet.floorLabel).toBe("Third floor");
    expect(sheet.access.find((l) => l.label === "Front door code")?.value).toBe("SECRET-access-doorCode");
    expect(sheet.wifi.find((l) => l.label === "Password")?.value).toBe("SECRET-wifi-password");
    expect(sheet.roomInstructions).toBe("SECRET-room-6-notes");
    // Its QR is a login page, never a secret.
    expect(sheet.portalUrl).toBe("https://prop-lane.space/resident");
  });
});

describe("what the public page shows when the house is thin", () => {
  it("falls back to the legacy free-text rules when no structured rule is filled", () => {
    const page = buildHousePublicPage(house({ houseInfo: undefined, houseRulesText: "Quiet after 11. No smoking." }));
    expect(page.rules).toEqual([]);
    expect(page.rulesText).toBe("Quiet after 11. No smoking.");
    expect(housePublicPageIsEmpty(page)).toBe(false);
  });

  it("is empty — and says so — when nothing has been written", () => {
    const page = buildHousePublicPage(house({ houseInfo: undefined, houseRulesText: "" }));
    expect(housePublicPageIsEmpty(page)).toBe(true);
    expect(page.name).toBe("Ballard House");
  });

  it("names the house by its street when it has no name", () => {
    const page = buildHousePublicPage(house({ buildingName: "" }));
    expect(page.name).toBe("5257 Brooklyn Ave NE");
  });
});
