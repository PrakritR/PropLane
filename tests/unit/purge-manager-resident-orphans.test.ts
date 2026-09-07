import { describe, expect, it, vi } from "vitest";
import {
  isProtectedOccupancyImportEmail,
  purgeManagerResidentOrphans,
} from "@/lib/auth/purge-manager-resident-orphans";

describe("isProtectedOccupancyImportEmail", () => {
  it("protects Airbnb occupancy import placeholders", () => {
    expect(isProtectedOccupancyImportEmail("occupancy.michelle.r5@import.proplane.local")).toBe(true);
    expect(isProtectedOccupancyImportEmail("saarmedia783@gmail.com")).toBe(false);
  });
});

describe("purgeManagerResidentOrphans", () => {
  it("deletes charges, ledger, resident reminders, and scheduled inbox for non-current emails", async () => {
    const deletedCalls: { table: string; ids: string[] }[] = [];
    const rowsByTable: Record<string, unknown[]> = {
      manager_application_records: [
        {
          id: "app-keep",
          resident_email: "keep@example.com",
          row_data: { bucket: "approved", stage: "Approved" },
        },
        {
          id: "app-gone",
          resident_email: "gone@example.com",
          row_data: { bucket: "approved", stage: "Moved out", manualResidentDetails: { moveOutDate: "2020-01-01" } },
        },
        {
          id: "app-pending",
          resident_email: "pending@example.com",
          row_data: { bucket: "pending" },
        },
      ],
      portal_household_charge_records: [
        { id: "c1", resident_email: "keep@example.com" },
        { id: "c2", resident_email: "gone@example.com" },
        { id: "c3", resident_email: "occupancy.x@import.proplane.local" },
      ],
      portal_recurring_rent_profile_records: [],
      portal_lease_pipeline_records: [],
      portal_work_order_records: [],
      portal_service_request_records: [],
      manager_payment_plans: [],
      ledger_entries: [
        { id: "l1", resident_email: "gone@example.com" },
        { id: "l2", resident_email: "keep@example.com" },
      ],
      security_deposit_ledger: [],
      portal_reminder_records: [
        { id: "r1", recipient_email: "gone@example.com" },
        { id: "r2", recipient_email: "manager-co@example.com" },
      ],
      portal_scheduled_inbox_message_records: [
        { id: "s1", row_data: { recipientEmail: "ghost@example.com" } },
        { id: "s2", row_data: { recipientEmail: "keep@example.com" } },
      ],
      portal_inbox_thread_records: [
        { id: "t1", participant_email: "gone@example.com" },
        { id: "t2", participant_email: "keep@example.com" },
      ],
    };

    const db = {
      from: vi.fn((table: string) => {
        const state = {
          filters: [] as { col: string; val: string }[],
          ids: null as string[] | null,
        };
        const chain: Record<string, unknown> = {
          select: vi.fn(() => chain),
          eq: vi.fn((col: string, val: string) => {
            state.filters.push({ col, val });
            return chain;
          }),
          in: vi.fn((_col: string, ids: string[]) => {
            state.ids = ids;
            return chain;
          }),
          delete: vi.fn(() => chain),
          then: (resolve: (value: { data: unknown[]; error: null }) => void) => {
            if (state.ids) {
              deletedCalls.push({ table, ids: state.ids });
              resolve({ data: null as unknown as unknown[], error: null });
              return;
            }
            let rows = [...(rowsByTable[table] ?? [])];
            // Simulate recipient_role=resident filter on reminders
            if (table === "portal_reminder_records" && state.filters.some((f) => f.col === "recipient_role")) {
              rows = rows.filter((r) => (r as { id: string }).id === "r1");
            }
            resolve({ data: rows, error: null });
          },
        };
        return chain;
      }),
    };

    const result = await purgeManagerResidentOrphans(
      db as unknown as Parameters<typeof purgeManagerResidentOrphans>[0],
      "mgr-1",
      { currentOnly: true },
    );

    expect(result.activeEmails.sort()).toEqual(["keep@example.com", "pending@example.com"]);
    expect(result.deletedApplicationIds).toEqual(["app-gone"]);
    expect(result.deleted.portal_household_charge_records).toBe(1);
    expect(result.deleted.ledger_entries).toBe(1);
    expect(result.deleted.portal_reminder_records).toBe(1);
    expect(result.deleted.portal_scheduled_inbox_message_records).toBe(1);
    expect(result.deleted.portal_inbox_thread_records).toBe(1);
    expect(result.purgedEmails).toEqual(expect.arrayContaining(["gone@example.com", "ghost@example.com"]));
    expect(result.purgedEmails).not.toContain("occupancy.x@import.proplane.local");
  });

  it("refuses to wipe when the manager has no active residents", async () => {
    const db = {
      from: vi.fn(() => {
        const chain: Record<string, unknown> = {
          select: vi.fn(() => chain),
          eq: vi.fn(() => chain),
          then: (resolve: (value: { data: unknown[]; error: null }) => void) =>
            resolve({ data: [], error: null }),
        };
        return chain;
      }),
    };

    const result = await purgeManagerResidentOrphans(
      db as unknown as Parameters<typeof purgeManagerResidentOrphans>[0],
      "mgr-empty",
      { currentOnly: true },
    );
    expect(result.deleted).toEqual({});
    expect(result.activeEmails).toEqual([]);
  });
});
