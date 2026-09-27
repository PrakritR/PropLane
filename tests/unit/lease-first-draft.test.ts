/**
 * Part 3 hotfix, defect 4: "Send lease to sign" (lease-first) used to only
 * email a create-account link — `POST /api/portal/send-lead-invite` never
 * created a lease row, so the resident's Lease tab stayed locked with
 * nothing on it to unlock, and the manager's Leases list showed nothing.
 *
 * `createLeaseFirstDraft` makes the send real: a genuine, server-authorized
 * `Draft` lease row, idempotent per (manager, property, room, resident
 * email).
 */
import { describe, expect, it } from "vitest";
import { createLeaseFirstDraft } from "@/lib/leasing/lease-first-draft.server";
import { fakeSupabaseClient } from "./helpers/fake-supabase-tables";

const MANAGER_ID = "manager-lease-first";
const PROPERTY_ID = "prop-oak-4417";

describe("createLeaseFirstDraft", () => {
  it("creates a real Draft lease row, scoped to the manager, property, and resident email", async () => {
    const db = fakeSupabaseClient({ portal_lease_pipeline_records: [] });

    const result = await createLeaseFirstDraft(db as never, {
      managerUserId: MANAGER_ID,
      propertyId: PROPERTY_ID,
      roomChoice: "room-2",
      name: "Jordan Lee",
      email: "Jordan.Lee@Example.com",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.created).toBe(true);

    const stored = (await (db.from("portal_lease_pipeline_records").select("*") as never as Promise<{ data: Record<string, unknown>[] }>)).data;
    expect(stored).toHaveLength(1);
    const record = stored[0]!;
    expect(record.manager_user_id).toBe(MANAGER_ID);
    expect(record.property_id).toBe(PROPERTY_ID);
    // Server-normalized: lowercased, trimmed — never trusts client casing.
    expect(record.resident_email).toBe("jordan.lee@example.com");
    expect(record.status).toBe("manager");
    const rowData = record.row_data as Record<string, unknown>;
    expect(rowData.leaseFirst).toBe(true);
    expect(rowData.bucket).toBe("manager");
    expect(rowData.status).toBe("Draft");
    expect(rowData.residentEmail).toBe("jordan.lee@example.com");
    expect(rowData.residentName).toBe("Jordan Lee");
    expect(rowData.propertyId).toBe(PROPERTY_ID);
    expect(rowData.roomChoice).toBe("room-2");
    // No document exists yet — nothing to sign, nothing claiming execution.
    expect(rowData.generatedHtml).toBeFalsy();
    expect(rowData.residentSignature).toBeFalsy();
  });

  it("is idempotent: a second send for the same person/property/room reuses the draft", async () => {
    const db = fakeSupabaseClient({ portal_lease_pipeline_records: [] });
    const params = {
      managerUserId: MANAGER_ID,
      propertyId: PROPERTY_ID,
      roomChoice: "room-2",
      name: "Jordan Lee",
      email: "jordan.lee@example.com",
    };

    const first = await createLeaseFirstDraft(db as never, params);
    const second = await createLeaseFirstDraft(db as never, params);

    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.leaseId).toBe(first.leaseId);

    const stored = (await (db.from("portal_lease_pipeline_records").select("*") as never as Promise<{ data: unknown[] }>)).data;
    expect(stored).toHaveLength(1);
  });

  it("creates a SEPARATE draft for a different resident email under the same property", async () => {
    const db = fakeSupabaseClient({ portal_lease_pipeline_records: [] });
    const first = await createLeaseFirstDraft(db as never, {
      managerUserId: MANAGER_ID,
      propertyId: PROPERTY_ID,
      email: "jordan.lee@example.com",
    });
    const second = await createLeaseFirstDraft(db as never, {
      managerUserId: MANAGER_ID,
      propertyId: PROPERTY_ID,
      email: "casey.odom@example.com",
    });

    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.leaseId).not.toBe(second.leaseId);
  });

  it("refuses without a manager or property", async () => {
    const db = fakeSupabaseClient({ portal_lease_pipeline_records: [] });
    const result = await createLeaseFirstDraft(db as never, {
      managerUserId: MANAGER_ID,
      propertyId: "",
      email: "jordan.lee@example.com",
    });
    expect(result.ok).toBe(false);
  });

  it("refuses without a resident email", async () => {
    const db = fakeSupabaseClient({ portal_lease_pipeline_records: [] });
    const result = await createLeaseFirstDraft(db as never, {
      managerUserId: MANAGER_ID,
      propertyId: PROPERTY_ID,
      email: "   ",
    });
    expect(result.ok).toBe(false);
  });
});
