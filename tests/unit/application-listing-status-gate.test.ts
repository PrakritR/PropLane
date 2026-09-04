import { describe, expect, it } from "vitest";

import {
  LISTING_NOT_ACCEPTING_APPLICATIONS_ERROR,
  prepareGuestApplicationUpsert,
  propertyStatusAcceptsApplications,
  resolvePropertyApplicationTarget,
} from "@/lib/auth/guest-application-upsert";

/**
 * `resolveManagerUserIdForProperty` returned the owner regardless of listing
 * status, and it was the only property check on both submit paths (PRP-206). So
 * a resident who opened a listing before the manager unpublished it could still
 * submit weeks later: the resident got a success screen, the manager got an
 * application for a property they deliberately took down, and the applicant may
 * have paid an application fee for a home that is not available.
 */
function fakeDb(record: Record<string, unknown> | null) {
  return {
    from() {
      return {
        select: () => ({
          eq: () => ({ maybeSingle: async () => ({ data: record, error: null }) }),
        }),
      };
    },
  } as never;
}

describe("propertyStatusAcceptsApplications", () => {
  it("accepts only a live listing", () => {
    expect(propertyStatusAcceptsApplications("live")).toBe(true);
    for (const status of ["pending", "review", "request_change", "unlisted", "rejected", "draft"]) {
      expect(propertyStatusAcceptsApplications(status)).toBe(false);
    }
  });

  it("treats a missing status as not accepting", () => {
    expect(propertyStatusAcceptsApplications(null)).toBe(false);
    expect(propertyStatusAcceptsApplications(undefined)).toBe(false);
  });
});

describe("resolvePropertyApplicationTarget", () => {
  it("still resolves the owner, so attribution is unchanged", async () => {
    const target = await resolvePropertyApplicationTarget(
      fakeDb({ manager_user_id: "mgr-1", status: "live", property_data: {} }),
      "prop-1",
    );
    expect(target).toEqual({ managerUserId: "mgr-1", status: "live", acceptsApplications: true });
  });

  it("reports an unlisted property as not accepting, owner and all", async () => {
    const target = await resolvePropertyApplicationTarget(
      fakeDb({ manager_user_id: "mgr-1", status: "unlisted", property_data: {} }),
      "prop-1",
    );
    expect(target.managerUserId).toBe("mgr-1");
    expect(target.acceptsApplications).toBe(false);
  });

  it("fails CLOSED on an unknown listing rather than treating a missing row as permissive", async () => {
    const target = await resolvePropertyApplicationTarget(fakeDb(null), "prop-1");
    expect(target.acceptsApplications).toBe(false);
  });

  it("still reads the legacy managerUserId out of property_data", async () => {
    const target = await resolvePropertyApplicationTarget(
      fakeDb({ manager_user_id: null, status: "live", property_data: { managerUserId: "mgr-legacy" } }),
      "prop-1",
    );
    expect(target.managerUserId).toBe("mgr-legacy");
  });
});

describe("the guest submit path", () => {
  const row = {
    id: "AXIS-APP1",
    email: "applicant@example.com",
    bucket: "pending",
    propertyId: "prop-1",
  } as never;

  it("refuses a new application against an unpublished listing, before any fee", async () => {
    const result = await prepareGuestApplicationUpsert(
      fakeDb({ manager_user_id: "mgr-1", status: "unlisted", property_data: {} }),
      { row },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(409);
    expect(result.error).toBe(LISTING_NOT_ACCEPTING_APPLICATIONS_ERROR);
    // Specific about why, and it names somewhere to go.
    expect(result.error).toMatch(/no longer accepting/i);
    expect(result.error).toMatch(/browse/i);
  });

  it("still accepts one against a live listing", async () => {
    const result = await prepareGuestApplicationUpsert(
      fakeDb({ manager_user_id: "mgr-1", status: "live", property_data: {} }),
      { row },
    );
    expect(result.ok).toBe(true);
  });

  it("does not strand an application already in flight when the listing goes down", async () => {
    // Refusing mid-wizard would throw away work the applicant has already done,
    // and this path handles progressive saves as well as the final submit.
    const result = await prepareGuestApplicationUpsert(
      fakeDb({ manager_user_id: "mgr-1", status: "unlisted", property_data: {} }),
      { row, existing: { ...row, managerUserId: "mgr-1" } as never },
    );
    expect(result.ok).toBe(true);
  });
});
