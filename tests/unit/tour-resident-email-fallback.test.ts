import { describe, expect, it } from "vitest";
import {
  isResidentTourLinksSchemaError,
  loadResidentTourViews,
  residentHasTourLinks,
  resolveResidentTourLinks,
} from "@/lib/tour-resident-link.server";
import { createMemoryDb } from "./support/memory-supabase";

const INQUIRIES_RECORD_ID = "axis_admin_partner_inquiries_v1";

function dbWithSchemaGap(inquiries: Record<string, unknown>[]) {
  const linksSchemaError = {
    message: "Could not find the table 'public.resident_tour_links' in the schema cache",
  };
  return {
    from: (table: string) => {
      if (table === "resident_tour_links") {
        return {
          select: (_cols?: string, opts?: { count?: string; head?: boolean }) => {
            if (opts?.head) {
              return {
                eq: async () => ({ count: 0, error: linksSchemaError }),
              };
            }
            return {
              eq: () => ({
                order: async () => ({ data: null, error: linksSchemaError }),
              }),
            };
          },
        };
      }
      return {
        select: () => ({
          eq: (_column: string, id: string) => ({
            maybeSingle: async () => ({
              data: {
                row_data: {
                  payload: id === INQUIRIES_RECORD_ID ? inquiries : [],
                },
              },
              error: null,
            }),
          }),
        }),
      };
    },
  };
}

describe("resident tour email fallback", () => {
  it("returns existing links only for their original Auth subject", async () => {
    const db = createMemoryDb({ resident_tour_links: [{ id: "link", resident_user_id: "old-subject", inquiry_id: "inq-1", attendee_email: "resident@test.proplane.local", linked_at: "2026-01-01" }] });
    expect(await resolveResidentTourLinks(db as never, { userId: "old-subject", email: "resident@test.proplane.local" })).toHaveLength(1);
    expect(await resolveResidentTourLinks(db as never, { userId: "new-subject", email: "resident@test.proplane.local" })).toEqual([]);
  });
  it("detects missing resident_tour_links schema errors", () => {
    expect(
      isResidentTourLinksSchemaError("Could not find the table 'public.resident_tour_links' in the schema cache"),
    ).toBe(true);
    expect(isResidentTourLinksSchemaError("connection reset")).toBe(false);
  });

  it("does not expose email-matched tours when the links table is absent", async () => {
    const db = dbWithSchemaGap([
      {
        id: "inq-tour-1",
        kind: "tour",
        email: "resident@test.proplane.local",
        status: "pending",
        propertyTitle: "Lakeview Studio",
        proposedStart: "2026-08-10T17:00:00.000Z",
        proposedEnd: "2026-08-10T17:30:00.000Z",
      },
    ]);

    await expect(loadResidentTourViews(db as never, "new-auth-subject", { email: "resident@test.proplane.local" })).rejects.toThrow(/resident_tour_links/);
  });

  it("does not derive tour access from an email match when the links table is absent", async () => {
    const db = dbWithSchemaGap([
      { id: "inq-tour-1", kind: "tour", email: "resident@test.proplane.local" },
    ]);

    await expect(
      residentHasTourLinks(db as never, "res-1", "resident@test.proplane.local"),
    ).resolves.toBe(false);
  });
});
