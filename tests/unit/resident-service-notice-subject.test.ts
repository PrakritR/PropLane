/**
 * The last payload-email resident recipient in the vendor service path.
 *
 * `markWorkOrderDoneByVendor` was converted in this release to name the resident by the row's bound
 * Auth subject; "On my way" was not, and still mailed the service reference, title, house label and
 * ETA to whatever `row_data.residentEmail` held — stale, or someone else entirely.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ workOrderEvent: vi.fn(async () => undefined) }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/work-order-events.server", () => ({ workOrderEvent: mocks.workOrderEvent }));

import { markVendorEnRoute } from "@/lib/work-order-en-route.server";

const VENDOR = "vendor-auth-id";
const RESIDENT = "22222222-2222-4222-8222-222222222222";

function db(record: Record<string, unknown>) {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: record, error: null }) }),
      }),
      update: () => ({
        eq: () => ({ is: () => ({ select: () => ({ maybeSingle: async () => ({ data: { id: "wo-1" }, error: null }) }) }) }),
      }),
    }),
  };
}

const actor = { userId: VENDOR, email: "vendor@example.test", fullName: "Vera Vendor", admin: false, role: "vendor" };

const row = {
  id: "wo-1",
  bucket: "scheduled",
  reference: "WO-1",
  title: "Leaking tap",
  propertyName: "5257 Brooklyn",
  residentEmail: "stale-or-someone-else@example.test",
};

beforeEach(() => mocks.workOrderEvent.mockClear());

describe("the en-route notice names the resident by the row's bound subject", () => {
  it("sends to the bound subject, never to the payload email", async () => {
    const result = await markVendorEnRoute(
      db({ manager_user_id: "manager-1", vendor_user_id: VENDOR, resident_user_id: RESIDENT, row_data: row }) as never,
      actor,
      { workOrderId: "wo-1", etaMinutes: 20 },
    );

    expect(result).toMatchObject({ ok: true, alreadyEnRoute: false });
    expect(mocks.workOrderEvent).toHaveBeenCalledTimes(1);
    const sent = mocks.workOrderEvent.mock.calls[0]![1] as { recipients: Array<Record<string, unknown>> };
    expect(sent.recipients).toEqual([{ audience: "resident", userId: RESIDENT }]);
    expect(JSON.stringify(sent.recipients)).not.toContain("stale-or-someone-else@example.test");
  });

  it("sends the resident nothing at all on an unbound row", async () => {
    const result = await markVendorEnRoute(
      db({ manager_user_id: "manager-1", vendor_user_id: VENDOR, resident_user_id: null, row_data: row }) as never,
      actor,
      { workOrderId: "wo-1" },
    );

    expect(result).toMatchObject({ ok: true, alreadyEnRoute: false });
    expect(mocks.workOrderEvent).not.toHaveBeenCalled();
  });
});
