/**
 * "Text your manager" has to FOLLOW the lease.
 *
 * A resident moves and signs under a different manager; the number they are
 * told to text must become the new one the moment that lease is real. The
 * number is therefore never stored on the resident — it is derived on every
 * read — and these lock the derivation, including the mid-move case where
 * showing one manager silently would misroute a message at exactly the moment
 * the two houses are easiest to confuse.
 */
import { describe, expect, it, vi } from "vitest";
import {
  classifyTenancy,
  resolveResidentManagerContacts,
} from "@/lib/resident-manager-contact.server";
import { createMemoryDb } from "./support/memory-supabase";

vi.mock("@/lib/sms/manager-number-provisioning.server", () => ({
  resolveActiveManagerSendNumber: vi.fn(async () => "+12065559000"),
}));

const NOW = Date.parse("2026-10-15T12:00:00Z");

function lease(over: Record<string, unknown> = {}) {
  return {
    manager_user_id: "mgr-a",
    property_id: "prop-a",
    resident_email: "res@example.com",
    resident_user_id: "res-1",
    status: "signed",
    updated_at: "2026-10-01T00:00:00Z",
    row_data: { propertyLabel: "4709A 8th Ave NE", leaseStart: "2026-09-01", leaseEnd: "2027-08-31" },
    ...over,
  };
}

describe("classifyTenancy", () => {
  it("reads a lease running today as current", () => {
    expect(classifyTenancy("2026-09-01", "2027-08-31", NOW)).toBe("current");
  });
  it("reads a lease that has not started as upcoming", () => {
    expect(classifyTenancy("2026-11-01", "2027-10-31", NOW)).toBe("upcoming");
  });
  it("reads a finished lease as ended", () => {
    expect(classifyTenancy("2025-09-01", "2026-08-31", NOW)).toBe("ended");
  });
  it("never treats a missing date as a boundary", () => {
    // No end means it has not ended; no start means it has begun. Guessing
    // either way would hide a number the resident still needs.
    expect(classifyTenancy("2026-09-01", null, NOW)).toBe("current");
    expect(classifyTenancy(null, null, NOW)).toBe("current");
  });
});

describe("resolveResidentManagerContacts", () => {
  it("returns the manager of the resident's current lease", async () => {
    const db = createMemoryDb({ portal_lease_pipeline_records: [lease()] }) as never;
    const out = await resolveResidentManagerContacts(db, {
      residentUserId: "res-1",
      residentEmail: "res@example.com",
      nowMs: NOW,
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.managerUserId).toBe("mgr-a");
    expect(out[0]!.status).toBe("current");
  });

  it("shows BOTH managers mid-move rather than picking one", async () => {
    const db = createMemoryDb({
      portal_lease_pipeline_records: [
        lease({ updated_at: "2026-10-10T00:00:00Z", manager_user_id: "mgr-b", property_id: "prop-b",
          row_data: { propertyLabel: "5259 Brooklyn Ave NE", leaseStart: "2026-11-01", leaseEnd: "2027-10-31" } }),
        lease({ row_data: { propertyLabel: "4709A 8th Ave NE", leaseStart: "2026-09-01", leaseEnd: "2026-10-31" } }),
      ],
    }) as never;
    const out = await resolveResidentManagerContacts(db, { residentUserId: "res-1", nowMs: NOW });
    expect(out.map((c) => c.managerUserId).sort()).toEqual(["mgr-a", "mgr-b"]);
    expect(out.find((c) => c.managerUserId === "mgr-b")!.status).toBe("upcoming");
    expect(out.find((c) => c.managerUserId === "mgr-a")!.status).toBe("current");
  });

  it("keeps a former manager reachable when nothing current exists", async () => {
    // Move-out questions and the deposit return are exactly when a former
    // resident most needs to reach someone.
    const db = createMemoryDb({
      portal_lease_pipeline_records: [
        lease({ row_data: { propertyLabel: "4709A", leaseStart: "2025-09-01", leaseEnd: "2026-08-31" } }),
      ],
    }) as never;
    const out = await resolveResidentManagerContacts(db, { residentUserId: "res-1", nowMs: NOW });
    expect(out).toHaveLength(1);
    expect(out[0]!.status).toBe("ended");
  });

  it("drops an ended tenancy once a live one exists", async () => {
    const db = createMemoryDb({
      portal_lease_pipeline_records: [
        lease({ updated_at: "2026-10-10T00:00:00Z", manager_user_id: "mgr-b",
          row_data: { propertyLabel: "5259", leaseStart: "2026-09-15", leaseEnd: "2027-09-14" } }),
        lease({ row_data: { propertyLabel: "4709A", leaseStart: "2025-09-01", leaseEnd: "2026-08-31" } }),
      ],
    }) as never;
    const out = await resolveResidentManagerContacts(db, { residentUserId: "res-1", nowMs: NOW });
    expect(out.map((c) => c.managerUserId)).toEqual(["mgr-b"]);
  });

  it("lists one manager once even across several of their leases", async () => {
    const db = createMemoryDb({
      portal_lease_pipeline_records: [lease({ property_id: "prop-a" }), lease({ property_id: "prop-a2" })],
    }) as never;
    const out = await resolveResidentManagerContacts(db, { residentUserId: "res-1", nowMs: NOW });
    expect(out).toHaveLength(1);
  });

  it("returns nothing without an identity to scope by", async () => {
    const db = createMemoryDb({ portal_lease_pipeline_records: [lease()] }) as never;
    await expect(resolveResidentManagerContacts(db, {})).resolves.toEqual([]);
  });
});
