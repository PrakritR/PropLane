import { describe, expect, it } from "vitest";

import type { DemoApplicantRow } from "@/data/demo-portal";
import {
  applicationPropertyKey,
  applicationRoomKey,
  findDuplicateApplication,
} from "@/lib/rental-application/duplicate-application.server";

/**
 * The only duplicate guard was `residentApplicationSubmitBlocked`, which reads
 * `window.sessionStorage` — so it passed in a new tab, on another device, in
 * incognito, for a guest applicant, and after the session store was cleared
 * (PRP-204). The manager then got two pending applications for the same person
 * and room with nothing marking them as duplicates, and under an `every_time`
 * fee policy the applicant was billed twice.
 */
function submitted(overrides: Partial<DemoApplicantRow> = {}): DemoApplicantRow {
  return {
    id: "AXIS-A1",
    email: "applicant@example.com",
    bucket: "pending",
    stage: "Submitted",
    propertyId: "prop-1",
    application: { roomChoice1: "Room 2" },
    ...overrides,
  } as DemoApplicantRow;
}

function fakeDb(rows: { id: string; row_data: DemoApplicantRow }[]) {
  return {
    from() {
      return {
        select: () => ({
          eq: () => ({ limit: async () => ({ data: rows, error: null }) }),
        }),
      };
    },
  } as never;
}

const NEW_ROW = submitted({ id: "AXIS-NEW" });

describe("findDuplicateApplication", () => {
  it("finds the same person's submitted application for the same property and room", async () => {
    const match = await findDuplicateApplication(fakeDb([{ id: "AXIS-A1", row_data: submitted() }]), {
      residentEmail: "applicant@example.com",
      row: NEW_ROW,
    });
    expect(match?.id).toBe("AXIS-A1");
  });

  it("allows a different room in the same property", async () => {
    const other = submitted({ application: { roomChoice1: "Room 5" } as never });
    const match = await findDuplicateApplication(fakeDb([{ id: "AXIS-A1", row_data: other }]), {
      residentEmail: "applicant@example.com",
      row: NEW_ROW,
    });
    expect(match).toBeNull();
  });

  it("allows a different property", async () => {
    const other = submitted({ propertyId: "prop-9" });
    const match = await findDuplicateApplication(fakeDb([{ id: "AXIS-A1", row_data: other }]), {
      residentEmail: "applicant@example.com",
      row: NEW_ROW,
    });
    expect(match).toBeNull();
  });

  it("does not treat a half-finished draft as an application already made", async () => {
    const draft = submitted({ stage: "In progress" });
    const match = await findDuplicateApplication(fakeDb([{ id: "AXIS-A1", row_data: draft }]), {
      residentEmail: "applicant@example.com",
      row: NEW_ROW,
    });
    expect(match).toBeNull();
  });

  it("lets a returning applicant re-apply after withdrawing", async () => {
    const withdrawn = submitted({ withdrawnAt: "2026-08-01T00:00:00Z" });
    const match = await findDuplicateApplication(fakeDb([{ id: "AXIS-A1", row_data: withdrawn }]), {
      residentEmail: "applicant@example.com",
      row: NEW_ROW,
    });
    expect(match).toBeNull();
  });

  it("never collides with itself on an edit", async () => {
    const match = await findDuplicateApplication(fakeDb([{ id: "AXIS-A1", row_data: submitted() }]), {
      residentEmail: "applicant@example.com",
      row: submitted(),
      excludeId: "AXIS-A1",
    });
    expect(match).toBeNull();
  });

  it("ignores an approved or rejected application — only a pending one is a duplicate", async () => {
    const approved = submitted({ bucket: "approved" as never });
    const match = await findDuplicateApplication(fakeDb([{ id: "AXIS-A1", row_data: approved }]), {
      residentEmail: "applicant@example.com",
      row: NEW_ROW,
    });
    expect(match).toBeNull();
  });
});

describe("the keys match what the submit paths use", () => {
  it("reads the room from either field the client guard reads", () => {
    expect(applicationRoomKey({ application: { roomChoice1: "Room 2" } } as never)).toBe("Room 2");
    expect(applicationRoomKey({ assignedRoomChoice: "Room 3" } as never)).toBe("Room 3");
  });

  it("reads the property with the submit paths' fallback order", () => {
    expect(applicationPropertyKey({ propertyId: "p1" } as never)).toBe("p1");
    expect(applicationPropertyKey({ assignedPropertyId: "p2" } as never)).toBe("p2");
    expect(applicationPropertyKey({ application: { propertyId: "p3" } } as never)).toBe("p3");
  });
});
