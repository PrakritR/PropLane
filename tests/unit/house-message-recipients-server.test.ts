/**
 * `loadHouseMessageRecipients` finds each resident's account case-insensitively: `profiles.email` is stored as typed,
 * so the lookup goes through the stored lowercase `profiles.email_lower` (migration 20261111130000) with lowercased
 * inputs - a mixed-case account still shows its phone, name and preferences instead of reading as "no account".
 */
import { describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ lookups: [] as Array<{ table: string; column: string; values: readonly string[] }> }));

vi.mock("@/lib/occupancy/snapshot.server", () => ({
  occupancySnapshotForManager: async () => ({
    stays: [
      {
        propertyId: "p1",
        roomLabel: "Room 1",
        start: "2026-01-01",
        end: "2027-01-01",
        resident: { source: "proplane", residentEmail: "  Ann@Example.COM ", residentName: "Ann Stay" },
      },
    ],
  }),
}));
vi.mock("@/lib/recipient-channels.server", () => ({ loadReachByForEmails: async () => new Map() }));
vi.mock("@/lib/sms-consent", () => ({ isPhoneOptedOut: async () => false }));

import { loadHouseMessageRecipients } from "@/lib/house-message-recipients.server";

const db = {
  from(table: string) {
    const chain: Record<string, unknown> = {};
    chain.select = () => chain;
    chain.in = async (column: string, values: readonly string[]) => {
      h.lookups.push({ table, column, values });
      // The account is stored with the casing the person typed.
      return { data: [{ id: "u-ann", email: "Ann@Example.com", phone: "2065550101", full_name: "Ann Account" }], error: null };
    };
    return chain;
  },
};

describe("loadHouseMessageRecipients", () => {
  it("matches the account through email_lower with the lowercased address", async () => {
    const result = await loadHouseMessageRecipients(db as never, { ownerUserId: "owner", propertyId: "p1", today: "2026-11-10" });
    expect(h.lookups).toEqual([{ table: "profiles", column: "email_lower", values: ["ann@example.com"] }]);
    expect(result.people).toHaveLength(1);
    expect(result.people[0]).toMatchObject({
      id: "u-ann",
      userId: "u-ann",
      name: "Ann Account",
      email: "ann@example.com",
      propertyId: "p1",
      channels: { app: true, email: true, sms: true },
    });
  });
});
