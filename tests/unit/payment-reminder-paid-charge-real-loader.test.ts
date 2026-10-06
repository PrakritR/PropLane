import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { cancelFuturePaymentRemindersForCharge } from "@/lib/payment-reminder-lifecycle.server";
import { listingFromPropertyData } from "@/lib/household-charge-payment-eligibility";
import { createDefaultListingSubmission } from "@/lib/manager-listing-submission";

describe("paid application fee reminder cleanup with stored listings", () => {
  it("ignores an unrelated partial v1 property and reads only the paid charge's listing", async () => {
    const charge = {
      id: "paid-fee", managerUserId: "manager-1", propertyId: "target-property",
      propertyLabel: "Target", residentEmail: "applicant@example.com", residentName: "Applicant",
      kind: "application_fee", status: "paid", title: "Application fee",
      amountLabel: "$50.00", balanceLabel: "$0.00", createdAt: "2026-10-01T00:00:00.000Z",
      paidAt: "2026-10-02T00:00:00.000Z",
    };
    const properties = [
      { id: "target-property", manager_user_id: "manager-1",
        property_data: { listingSubmission: createDefaultListingSubmission() } },
      { id: "unrelated-partial-property", manager_user_id: "manager-1",
        property_data: { listingSubmission: { v: 1, rooms: [] } } },
    ];
    const propertyIdFilters: string[][] = [];
    const db = { from(table: string) {
      const filters: Record<string, unknown> = {};
      const query = {
        select() { return query; },
        eq(key: string, value: unknown) { filters[key] = value; return query; },
        in(key: string, values: unknown[]) {
          filters[key] = values;
          if (table === "manager_property_records" && key === "id") propertyIdFilters.push(values.map(String));
          return query;
        },
        limit() { return query; },
        async maybeSingle() {
          if (table === "portal_household_charge_records") {
            return { data: { manager_user_id: "manager-1", row_data: charge }, error: null };
          }
          if (table === "manager_automation_settings") {
            return { data: { row_data: { overdueDailyEnabled: false, postDueReminderDays: [] } }, error: null };
          }
          if (table === "profiles") return { data: { full_name: "Manager" }, error: null };
          if (table === "manager_property_records" && filters.id === "target-property") {
            return { data: properties[0], error: null };
          }
          return { data: null, error: null };
        },
        then(resolve: (value: { data: unknown[]; error: null }) => unknown) {
          const data = table === "manager_property_records"
            ? properties.filter((row) => {
              const ids = filters.id as string[] | undefined;
              return !ids || ids.includes(row.id);
            })
            : [];
          return Promise.resolve({ data, error: null }).then(resolve);
        },
      };
      return query;
    } };

    await expect(cancelFuturePaymentRemindersForCharge(db as never, "manager-1", "paid-fee"))
      .resolves.toBe(0);
    expect(propertyIdFilters).toContainEqual(["target-property"]);
    expect(propertyIdFilters).not.toContainEqual(["unrelated-partial-property"]);
    expect(listingFromPropertyData(properties[1]!.property_data)).toBeNull();
  });
});
