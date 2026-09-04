/**
 * AXI-163 — "have a generic house move in section and specific house move in
 * [section] ... implement checkbox system".
 *
 * A room-by-room listing has two kinds of move-in detail: the shared house facts
 * (front door code, parking, bins) and what is specific to each room. The house
 * level existed in the data but was ENTIRE-HOME ONLY on the manager side and read
 * by nobody on the resident side — so shared facts had to be retyped into every
 * room, and even then the resident only ever saw their room's copy.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => ({}) }));

import { resolveResidentMoveInFromApplications } from "@/lib/resident-move-in-resolve";
import type { DemoApplicantRow } from "@/data/demo-portal";
import type { MockProperty } from "@/data/types";
import { createDefaultListingSubmission, emptyRoom } from "@/lib/manager-listing-submission";

function listing(entireHome: boolean) {
  return {
    ...createDefaultListingSubmission(),
    listingPlaceCategoryId: entireHome ? "entire_home" : "private_room",
    houseMoveInInstructions: "Front door code 4821. Bins go out Tuesday.",
    houseMoveInPhotoDataUrls: ["data:image/png;base64,house"],
    houseMoveInVideoDataUrl: null,
    rooms: [
      {
        ...emptyRoom(0),
        id: "room-1",
        name: "Room 1",
        moveInInstructions: "Your key is the brass one.",
        moveInPhotoDataUrls: ["data:image/png;base64,room"],
        moveInVideoDataUrl: null,
      },
    ],
  };
}

function resolve(entireHome: boolean) {
  const row = {
    id: "AXI-1",
    email: "jordan@example.com",
    name: "Jordan",
    bucket: "approved",
    assignedPropertyId: "property-1",
    assignedRoomChoice: "property-1::room-1",
    application: { propertyId: "property-1", roomChoice1: "property-1::room-1" },
  } as unknown as DemoApplicantRow;
  const property = {
    id: "property-1",
    title: "Brooklyn House",
    buildingName: "Brooklyn House",
    listingSubmission: listing(entireHome),
  } as unknown as MockProperty;
  return resolveResidentMoveInFromApplications("jordan@example.com", [row], { "property-1": property })!;
}

describe("move-in: whole house vs the resident's own room", () => {
  it("a room resident gets BOTH levels, not just their room's", () => {
    const resolved = resolve(false);
    expect(resolved.houseInstructions).toContain("Front door code");
    expect(resolved.houseMoveInPhotoDataUrls).toHaveLength(1);
    expect(resolved.instructions).toContain("brass one");
  });

  it("an entire-home listing does not print the same text twice", () => {
    // There the house IS the space, so a separate house block would duplicate it.
    const resolved = resolve(true);
    expect(resolved.houseInstructions).toBeNull();
    expect(resolved.houseMoveInPhotoDataUrls).toEqual([]);
    expect(resolved.instructions).toContain("Front door code");
  });
});

describe("manager move-in panel", () => {
  const panel = readFileSync("src/components/portal/pro-property-room-move-in-panel.tsx", "utf8");
  const view = readFileSync("src/components/portal/resident-move-in-view.tsx", "utf8");

  it("offers the house section to a room-by-room listing too", () => {
    expect(panel).toContain("The whole house");
    expect(panel).toContain("hideBackText");
    expect(panel).toContain('data-attr="property-move-in-house"');
    expect(panel).not.toContain("move-in-editor-save");
    expect(panel).not.toContain("earliest move-in date");
  });

  it("makes rooms selectable with edit and share bulk actions", () => {
    expect(panel).toContain("property-move-in-house-select");
    expect(panel).toContain("property-move-in-room-select-");
    expect(panel).toContain('data-attr="property-move-in-bulk-edit"');
    expect(panel).toContain('data-attr="property-move-in-share"');
    expect(panel).toContain("<BulkActionBar");
    expect(panel).not.toContain(">Clear<");
  });

  it("copies the SAVED house details, never the unsaved draft", () => {
    // Copying the draft would put text on rooms that the house section does not
    // itself show yet.
    expect(panel).toContain("sub.houseMoveInInstructions ?? \"\"");
    expect(panel).toContain("houseHasSavedDetails");
  });

  it("the resident view renders the two sections separately", () => {
    expect(view).toContain('data-attr="resident-move-in-house-section"');
    expect(view).toContain('data-attr="resident-move-in-room-section"');
  });
});
