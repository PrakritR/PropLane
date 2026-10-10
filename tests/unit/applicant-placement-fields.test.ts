/**
 * An applicant (guest or signed-in) never sets where they are placed: `assignedPropertyId` /
 * `assignedRoomChoice` are the manager's, and a `roomChoiceN` may only name a room of the listing the
 * applicant applied to. Readers count a row toward every house it names.
 */
import { describe, expect, it, vi } from "vitest";
import type { DemoApplicantRow } from "@/data/demo-portal";

vi.mock("@/lib/rental-application/duplicate-application.server", () => ({ findDuplicateApplication: async () => null }));
vi.mock("@/lib/rental-application/validate-submission.server", () => ({ validateSubmittedApplication: async () => ({ ok: true, errors: {} }) }));

import { applicantRoomChoicesForListing, prepareGuestApplicationUpsert } from "@/lib/auth/guest-application-upsert";

const LISTING = "listing-own";
const VICTIM = "house-victim";

const db = {
  from: () => ({
    select: () => ({
      eq: () => ({ maybeSingle: async () => ({ data: { manager_user_id: "owner-1", status: "live", property_data: {} }, error: null }) }),
    }),
  }),
} as never;

function guestRow(over: Record<string, unknown>): DemoApplicantRow {
  return {
    id: "AXIS-GUEST1",
    name: "Gus Guest",
    email: "gus@example.com",
    bucket: "pending",
    propertyId: LISTING,
    stage: "Submitted",
    detail: "",
    ...over,
  } as unknown as DemoApplicantRow;
}

describe("guest application upsert", () => {
  it("ignores a client-supplied assignedPropertyId / assignedRoomChoice and a foreign roomChoice", async () => {
    const result = await prepareGuestApplicationUpsert(db, {
      row: guestRow({
        assignedPropertyId: VICTIM,
        assignedRoomChoice: `${VICTIM}::room-1`,
        application: { propertyId: LISTING, roomChoice1: `${LISTING}::room-1`, roomChoice2: `${VICTIM}::room-1` },
      }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.row.assignedPropertyId).toBeUndefined();
    expect(result.row.assignedRoomChoice).toBeUndefined();
    const application = result.row.application as unknown as Record<string, string>;
    expect(application.roomChoice1).toBe(`${LISTING}::room-1`);
    expect(application.roomChoice2).toBe("");
  });

  it("does not take the listing from assignedPropertyId", async () => {
    const result = await prepareGuestApplicationUpsert(db, { row: guestRow({ propertyId: "", assignedPropertyId: VICTIM }) });
    expect(result.ok).toBe(false);
  });

  it("keeps the manager's stored placement on an existing application", async () => {
    const existing = guestRow({ assignedPropertyId: LISTING, assignedRoomChoice: `${LISTING}::room-9` });
    const result = await prepareGuestApplicationUpsert(db, {
      row: guestRow({ assignedPropertyId: VICTIM }),
      existing,
    });
    expect(result.ok && result.row.assignedPropertyId).toBe(LISTING);
    expect(result.ok && result.row.assignedRoomChoice).toBe(`${LISTING}::room-9`);
  });
});

describe("applicantRoomChoicesForListing", () => {
  it("drops choices naming another house, keeps the listing's own and a bare property id", () => {
    expect(
      applicantRoomChoicesForListing(
        { roomChoice1: `${LISTING}::a`, roomChoice2: LISTING, roomChoice3: `${VICTIM}::a`, leaseStart: "2026-10-01" } as never,
        LISTING,
      ),
    ).toEqual({ roomChoice1: `${LISTING}::a`, roomChoice2: LISTING, roomChoice3: "", leaseStart: "2026-10-01" });
  });
});
