/**
 * The Check-in guide and its privacy (checkin-1028): masked codes never reach the data, the staff-only
 * Internal section reaches no non-staff reader, and the public projection, printables and messages
 * carry neither the Internal values nor a room's door code.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: vi.fn() }));

import type { DemoApplicantRow } from "@/data/demo-portal";
import type { MockProperty } from "@/data/types";
import { buildCheckInGuide, checkInGuideMissingRoomCode, type CheckInSource } from "@/lib/check-in-guide";
import { checkInReveal } from "@/lib/check-in-reveal";
import {
  HOUSE_INFO_SECTIONS,
  containsHouseSecret,
  houseInfoInternalRows,
  houseInfoRenderSections,
  houseInfoSecretValues,
  houseInfoToPlainText,
  houseInfoWithoutInternal,
  houseInfoWithoutSecrets,
  normalizeHouseInfo,
} from "@/lib/house-info";
import { propertyRecordWithoutInternal } from "@/lib/house-info-visibility";
import { HOUSE_PRIVATE_SECTIONS, HOUSE_PUBLIC_SECTIONS, buildHouseDoorCard, buildHousePublicPage, buildHouseWelcomeSheet, housePrivateValues } from "@/lib/house-printables/model";
import { buildArrivalGuideSmsText, buildArrivalGuideText } from "@/lib/bookings/arrival-guide";
import { createDefaultListingSubmission, listingRoomSecretValues, normalizeManagerListingSubmissionV1, type ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import { publicListingProjection } from "@/lib/public-listings.server";
import { maskUnrevealedCheckIn, resolveResidentMoveInFromApplications } from "@/lib/resident-move-in-resolve";

const INTERNAL = { pantryCode: "2410", lockboxCode: "241", mailboxCode: "3711", notes: "Spare key behind the water heater 9087" };
const HOUSE_INFO = normalizeHouseInfo({
  access: { doorCode: "7500", gateCode: "#4821", keyPickup: "Lockbox left of the door", parking: "Street parking", notes: "Side gate sticks: code 5566" },
  wifi: { network: "Brooklyn5259", password: "pa55-word" },
  rules: { quietFrom: "22:00", quietTo: "07:00", smoking: "No smoking" },
  trash: { day: "Sunday" },
  checkout: { trash: "Take your trash to the bin", keys: "Leave the room door unlocked" },
  internal: INTERNAL,
});

function source(over: Partial<CheckInSource> = {}): CheckInSource {
  return {
    propertyLabel: "5259 Brooklyn",
    addressLine: "5259 Brooklyn Ave NE, 98105",
    roomLabel: "Room 9",
    houseInfo: houseInfoWithoutInternal(HOUSE_INFO),
    frontDoorPhotoUrl: "https://cdn.example/front.jpg",
    exteriorPhotoUrl: "https://cdn.example/outside.jpg",
    roomDoorCode: "9921",
    roomDoorPhotoUrl: "https://cdn.example/room9.jpg",
    checkInLabel: "Check-in from 3:00 PM Thursday, Oct 30",
    checkOutTimeLabel: "11:00 AM",
    ...over,
  };
}

const OPEN = checkInReveal({ kind: "tenancy", moveInAtIso: "2026-10-30T22:00:00.000Z", leaseSigned: true }, new Date("2026-10-30T20:00:00.000Z"));
const EARLY = checkInReveal({ kind: "tenancy", moveInAtIso: "2026-10-30T22:00:00.000Z", leaseSigned: true }, new Date("2026-10-27T20:00:00.000Z"));

describe("the guide", () => {
  it("shows the numbered steps with every code once revealed", () => {
    const guide = buildCheckInGuide(source(), OPEN, { checkInKey: "tenancy:rec-1" });
    expect(guide.revealed).toBe(true);
    expect(guide.steps.map((step) => step.id)).toEqual(["address", "front_door", "room", "wifi", "house_guide", "checkout"]);
    const flat = JSON.stringify(guide);
    for (const code of ["7500", "#4821", "9921", "pa55-word"]) expect(flat).toContain(code);
    expect(guide.steps.find((step) => step.id === "room")?.photoUrl).toBe("https://cdn.example/room9.jpg");
    expect(guide.steps.find((step) => step.id === "checkout")?.lines).toEqual(["Checkout is at 11:00 AM.", "Take your trash to the bin", "Leave the room door unlocked"]);
    expect(guide.checkInKey).toBe("tenancy:rec-1");
  });

  it("before the reveal every code is null in the DATA, the steps and photos stay, and the unlock time is named", () => {
    const guide = buildCheckInGuide(source(), EARLY);
    expect(guide.revealed).toBe(false);
    expect(guide.unlockLabel).toBe("Thu 3:00 PM");
    expect(guide.steps.length).toBe(6);
    const flat = JSON.stringify(guide);
    for (const code of ["7500", "#4821", "9921", "pa55-word", "5566", "Lockbox left of the door"]) expect(flat).not.toContain(code);
    const secrets = guide.steps.flatMap((step) => step.secrets);
    expect(secrets.filter((row) => row.label !== "Network").every((row) => row.value === null)).toBe(true);
    // The network name is not a secret; the photos are the steps' point.
    expect(flat).toContain("Brooklyn5259");
    expect(guide.steps.find((step) => step.id === "front_door")?.photoUrl).toBe("https://cdn.example/front.jpg");
  });

  it("never carries the staff-only Internal values, revealed or not", () => {
    for (const reveal of [OPEN, EARLY]) {
      const flat = JSON.stringify(buildCheckInGuide(source({ houseInfo: HOUSE_INFO }), reveal));
      for (const value of Object.values(INTERNAL)) expect(flat).not.toContain(value);
    }
  });

  it("a room with no door code says to ask the manager and is flagged for the manager", () => {
    const guide = buildCheckInGuide(source({ roomDoorCode: null }), OPEN);
    const room = guide.steps.find((step) => step.id === "room")!;
    expect(room.lines).toEqual(["Ask your manager for your room code."]);
    expect(room.secrets).toEqual([]);
    expect(checkInGuideMissingRoomCode(guide)).toBe(true);
    expect(checkInGuideMissingRoomCode(buildCheckInGuide(source(), OPEN))).toBe(false);
  });

  it("carries checked-in state, and draws no photo it was not given", () => {
    const guide = buildCheckInGuide(source({ frontDoorPhotoUrl: null, exteriorPhotoUrl: null, roomDoorPhotoUrl: null }), OPEN, { checkedInAt: "2026-10-30T22:42:00.000Z" });
    expect(guide.checkedInAt).toBe("2026-10-30T22:42:00.000Z");
    expect(guide.steps.every((step) => step.photoUrl === null)).toBe(true);
  });
});

describe("the Internal section", () => {
  it("is a section of the house details, every field secret and internal", () => {
    const spec = HOUSE_INFO_SECTIONS.find((s) => s.id === "internal")!;
    expect(spec.fields.map((f) => f.key)).toEqual(["pantryCode", "lockboxCode", "mailboxCode", "notes"]);
    expect(spec.fields.every((f) => f.secret && f.internal)).toBe(true);
  });

  it("is absent from the resident-facing render and plain text", () => {
    const rendered = JSON.stringify(houseInfoRenderSections(HOUSE_INFO)) + houseInfoToPlainText(HOUSE_INFO);
    for (const value of Object.values(INTERNAL)) expect(rendered).not.toContain(value);
  });

  it("the staff card reads them, and the non-staff projection empties them", () => {
    expect(houseInfoInternalRows(HOUSE_INFO).map((row) => `${row.label}=${row.value}`)).toEqual([
      "Pantry code=2410",
      "Lockbox code=241",
      "Mailbox code=3711",
      `Notes=${INTERNAL.notes}`,
    ]);
    expect(houseInfoWithoutInternal(HOUSE_INFO).internal).toEqual({});
    expect(houseInfoInternalRows(houseInfoWithoutInternal(HOUSE_INFO))).toEqual([]);
  });

  it("joins the secret set, so a post or a prospect/vendor text carrying a code is refused", () => {
    expect(houseInfoSecretValues(HOUSE_INFO)).toEqual(expect.arrayContaining(["2410", "241", "3711"]));
    expect(containsHouseSecret("pantry is 2410", HOUSE_INFO)).toBe(true);
    expect(containsHouseSecret("mailbox 3711 and lockbox 241", HOUSE_INFO)).toBe(true);
    expect(containsHouseSecret("see you at 2:41", HOUSE_INFO)).toBe(false);
  });

  it("a room's door code is a secret too", () => {
    const sub = { rooms: [{ doorCode: "9921" }, { doorCode: "" }, {}] };
    expect(listingRoomSecretValues(sub)).toEqual(["9921"]);
    expect(containsHouseSecret("room code 9921", HOUSE_INFO, listingRoomSecretValues(sub))).toBe(true);
    expect(containsHouseSecret("room code 9921", HOUSE_INFO)).toBe(false);
  });

  it("is removed from a stored property record for a reader without Properties edit access", () => {
    const row = { id: "p1", row_data: { submission: { houseInfo: HOUSE_INFO } }, property_data: { listingSubmission: { houseInfo: HOUSE_INFO, address: "1 Main" } } };
    const cleaned = propertyRecordWithoutInternal(row);
    expect(JSON.stringify(cleaned)).not.toContain("2410");
    expect(JSON.stringify(cleaned)).not.toContain("3711");
    expect((cleaned.property_data.listingSubmission as { address: string }).address).toBe("1 Main");
    // Nothing to remove -> the very same object, not a copy.
    expect(propertyRecordWithoutInternal(cleaned)).toBe(cleaned);
    // The original (the editor's copy) is untouched.
    expect(JSON.stringify(row)).toContain("2410");
  });
});

describe("masking on the resident payload", () => {
  const sub: ManagerListingSubmissionV1 = {
    ...createDefaultListingSubmission(),
    buildingName: "5259 Brooklyn",
    address: "5259 Brooklyn Ave NE",
    zip: "98105",
    houseInfo: HOUSE_INFO,
    frontDoorPhotoDataUrl: "https://cdn.example/front.jpg",
    exteriorPhotoDataUrl: "https://cdn.example/outside.jpg",
    rooms: [
      {
        ...createDefaultListingSubmission().rooms[0]!,
        id: "room-9",
        name: "Room 9",
        doorCode: "9921",
        doorPhotoDataUrl: "https://cdn.example/room9.jpg",
        moveInInstructions: "Second door on the left, spare key code 4455",
      },
    ],
  };
  const property = {
    id: "p1",
    title: "5259 Brooklyn",
    buildingName: "5259 Brooklyn",
    unitLabel: "",
    address: "5259 Brooklyn Ave NE",
    zip: "98105",
    listingSubmission: sub,
  } as unknown as MockProperty;
  const row = {
    id: "app-1",
    email: "matthew@example.com",
    name: "Matthew",
    bucket: "approved",
    stage: "Approved",
    property: "5259 Brooklyn",
    propertyId: "p1",
    assignedPropertyId: "p1",
    assignedRoomChoice: "p1::room-9",
    manualResidentDetails: { moveInDate: "2026-10-30" },
  } as unknown as DemoApplicantRow;
  const resolved = resolveResidentMoveInFromApplications("matthew@example.com", [row], { p1: property })!;

  it("the resolved house carries the room code and photos, and NEVER the Internal section", () => {
    expect(resolved.roomDoorCode).toBe("9921");
    expect(resolved.roomDoorPhotoDataUrl).toBe("https://cdn.example/room9.jpg");
    expect(resolved.frontDoorPhotoDataUrl).toBe("https://cdn.example/front.jpg");
    expect(resolved.houseInfo.internal).toEqual({});
    expect(JSON.stringify(resolved)).not.toContain("2410");
    expect(JSON.stringify(resolved)).not.toContain("3711");
  });

  it("before the reveal the browser is sent no code, no Wi-Fi password and no free-text instruction", () => {
    const masked = maskUnrevealedCheckIn(resolved);
    const flat = JSON.stringify(masked);
    for (const code of ["7500", "#4821", "9921", "pa55-word", "5566", "4455", "Lockbox left of the door"]) expect(flat).not.toContain(code);
    expect(masked.roomDoorCode).toBeNull();
    expect(masked.wifiPassword).toBeNull();
    // The non-secret house stays, and so do the photos that make the steps useful.
    expect(masked.houseInfo.rules.smoking).toBe("No smoking");
    expect(masked.houseInfo.wifi.network).toBe("Brooklyn5259");
    expect(masked.frontDoorPhotoDataUrl).toBe("https://cdn.example/front.jpg");
    expect(masked.roomDoorPhotoDataUrl).toBe("https://cdn.example/room9.jpg");
  });

  it("houseInfoWithoutSecrets empties every secret field", () => {
    const cleaned = houseInfoWithoutSecrets(HOUSE_INFO);
    expect(houseInfoSecretValues(cleaned)).toEqual([]);
    expect(cleaned.wifi.network).toBe("Brooklyn5259");
  });
});

describe("nothing public or outbound carries them", () => {
  const sub: ManagerListingSubmissionV1 = {
    ...createDefaultListingSubmission(),
    buildingName: "Ballard House",
    address: "5259 Brooklyn Ave NE",
    city: "Seattle",
    state: "WA",
    zip: "98105",
    houseInfo: HOUSE_INFO,
    frontDoorPhotoDataUrl: "https://cdn.example/secret-front.jpg",
    exteriorPhotoDataUrl: "https://cdn.example/secret-outside.jpg",
    rooms: [
      {
        ...createDefaultListingSubmission().rooms[0]!,
        id: "room-9",
        name: "Room 9",
        doorCode: "9921",
        doorPhotoDataUrl: "https://cdn.example/secret-room9.jpg",
      },
    ],
  };

  it("publicListingProjection drops the Internal values, the room door code and every door photo", () => {
    const projected = publicListingProjection({
      id: "p1",
      title: "Ballard House",
      tagline: "",
      address: "5259 Brooklyn Ave NE",
      zip: "98105",
      neighborhood: "U District",
      beds: 1,
      baths: 1,
      rentLabel: "$900",
      available: "Now",
      petFriendly: false,
      buildingId: "b1",
      buildingName: "Ballard House",
      unitLabel: "",
      adminPublishLive: true,
      listingSubmission: normalizeManagerListingSubmissionV1(sub),
    } as unknown as MockProperty);
    const flat = JSON.stringify(projected);
    for (const leaked of ["2410", "3711", "9921", "7500", "pa55-word", "secret-front", "secret-outside", "secret-room9", "doorCode", "frontDoorPhotoDataUrl", "exteriorPhotoDataUrl", "doorPhotoDataUrl"]) {
      expect(flat).not.toContain(leaked);
    }
  });

  it("the Internal and Checkout sections are on the private side of the printables", () => {
    expect(HOUSE_PRIVATE_SECTIONS).toEqual(expect.arrayContaining(["internal", "checkout"]));
    expect([...HOUSE_PUBLIC_SECTIONS, ...HOUSE_PRIVATE_SECTIONS].sort()).toEqual(HOUSE_INFO_SECTIONS.map((s) => s.id).sort());
    expect(housePrivateValues(sub)).toEqual(expect.arrayContaining(["2410", "241", "3711"]));
    const rendered = JSON.stringify([
      buildHousePublicPage(sub, { smsPhone: "+12065550142" }),
      buildHouseDoorCard(sub, { url: "https://prop-lane.space/h/abc", smsPhone: "+12065550142" }),
    ]);
    for (const secret of housePrivateValues(sub)) expect(rendered).not.toContain(secret);
    // Not even the resident's own welcome sheet prints the staff section.
    const sheet = JSON.stringify(buildHouseWelcomeSheet(sub, { roomId: "room-9", portalUrl: "https://prop-lane.space/resident", smsPhone: null }));
    for (const value of Object.values(INTERNAL)) expect(sheet).not.toContain(value);
  });

  it("the arrival message carries the room code and the house codes, and never the Internal values", () => {
    const input = {
      checkIn: "2026-10-30",
      checkInTime: "15:00",
      checkInUrl: "https://prop-lane.space/resident/move-in/check-in",
      guestName: "Matthew Rao",
      propertyLabel: "5259 Brooklyn",
      addressLine: "5259 Brooklyn Ave NE",
      roomLabel: "Room 9",
      roomDoorCode: "9921",
    };
    const full = buildArrivalGuideText(houseInfoWithoutInternal(HOUSE_INFO), input);
    const sms = buildArrivalGuideSmsText(houseInfoWithoutInternal(HOUSE_INFO), input);
    expect(full).toContain("7500");
    expect(full).toContain("Room 9 code: 9921");
    expect(full).toContain("https://prop-lane.space/resident/move-in/check-in");
    expect(sms).toContain("9921");
    expect(sms.length).toBeLessThanOrEqual(320);
    // Even if a caller forgot to strip the section, the builder only reads its own named keys.
    for (const text of [buildArrivalGuideText(HOUSE_INFO, input), buildArrivalGuideSmsText(HOUSE_INFO, input), full, sms]) {
      for (const value of Object.values(INTERNAL)) expect(text).not.toContain(value);
    }
  });
});
