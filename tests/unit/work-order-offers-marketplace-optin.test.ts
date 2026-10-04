/**
 * The marketplace broadcast is OPT IN. It fans an offer out to vendors the
 * manager never chose, so a caller that says nothing about the marketplace -
 * the assistant tool, any older client - must send only to the vendors named.
 * And only the vendors this send can actually reach get a roster row.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { matchedUserIds, trackMock } = vi.hoisted(() => ({
  matchedUserIds: { value: [] as string[], calls: 0 },
  trackMock: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/analytics/posthog", () => ({ track: (...a: unknown[]) => trackMock(...a) }));
vi.mock("@/lib/work-order-marketplace-match.server", () => ({
  loadMarketplaceVendorUserIds: async () => {
    matchedUserIds.calls += 1;
    return matchedUserIds.value;
  },
  resolveWorkOrderPropertyZip: async () => "98101",
  workOrderCategoryForMarketplace: () => "plumbing",
}));
vi.mock("@/lib/service-automation-settings.server", () => ({ resolveServiceAutomationSettingsForRow: async () => null }));
vi.mock("@/lib/settings/scope-resolver.server", () => ({ createSettingsScopeCache: () => ({}) }));
vi.mock("@/lib/co-manager-notification-recipients.server", () => ({ resolvePropertyScopedManagerRecipientIds: async () => [] }));
vi.mock("@/lib/work-order-events.server", () => ({ workOrderEvent: async () => undefined }));
vi.mock("@/lib/vendor-notification-delivery", () => ({ sendVendorNotification: async () => undefined }));
vi.mock("@/lib/work-order-notification.server", () => ({ notifyWorkOrderEvent: async () => undefined }));

import { MAX_VENDORS_PER_SEND, sendWorkOrderVendorOffers } from "@/lib/work-order-offers.server";

const MANAGER = "mgr-1";
type Row = Record<string, unknown>;

let rosterUpserts: Row[];

/** Chainable fake: enough for the work-order read, the roster lookups and the roster insert. */
function fakeDb() {
  rosterUpserts = [];
  const from = (table: string) => {
    const q: Record<string, unknown> = {
      select: () => q,
      eq: () => q,
      in: () => q,
      order: () => q,
      limit: () => q,
      maybeSingle: async () => {
        if (table === "portal_work_order_records") {
          return {
            data: { manager_user_id: MANAGER, row_data: { title: "Leak", category: "plumbing", propertyId: "h1" } },
            error: null,
          };
        }
        if (table === "vendor_business_profiles") {
          return {
            data: {
              business_name: "Apex",
              work_email: "a@apex.test",
              work_phone: "2065550123",
              trades: ["Plumbing"],
              directory_listed: true,
              onboarding_completed_at: "2026-01-01T00:00:00.000Z",
            },
            error: null,
          };
        }
        // No existing roster row for the matched vendor.
        return { data: null, error: null };
      },
      insert: async (payload: Row) => {
        if (table === "manager_vendor_records") rosterUpserts.push(payload);
        return { error: null };
      },
      upsert: async (payload: Row) => {
        if (table === "manager_vendor_records") rosterUpserts.push(payload);
        return { error: null };
      },
      update: () => q,
      then: (resolve: (v: { data: Row[]; error: null }) => unknown) => Promise.resolve({ data: [], error: null }).then(resolve),
    };
    return q;
  };
  return { from } as never;
}

const actor = { userId: MANAGER, email: "mgr@x.test", fullName: "Mgr", admin: false, role: "manager" as const };

beforeEach(() => {
  matchedUserIds.value = [];
  matchedUserIds.calls = 0;
  trackMock.mockClear();
});

describe("sendWorkOrderVendorOffers - the marketplace broadcast", () => {
  it("does not broadcast when the caller said nothing about the marketplace", async () => {
    matchedUserIds.value = ["v-stranger"];
    const result = await sendWorkOrderVendorOffers(fakeDb(), actor, { workOrderId: "wo-1", vendorIds: [] });
    // Nothing was matched, nothing was added to the roster, and the send is
    // refused for having no recipients rather than inventing some.
    expect(matchedUserIds.calls).toBe(0);
    expect(rosterUpserts).toEqual([]);
    expect(result).toMatchObject({ ok: false, status: 400 });
  });

  it("broadcasts only on an explicit opt in", async () => {
    matchedUserIds.value = ["v-stranger"];
    await sendWorkOrderVendorOffers(fakeDb(), actor, {
      workOrderId: "wo-1",
      vendorIds: [],
      marketplace: { enabled: true },
    });
    expect(matchedUserIds.calls).toBe(1);
    expect(rosterUpserts).toHaveLength(1);
  });

  it("creates a roster row only for the vendors the send can actually reach", async () => {
    matchedUserIds.value = Array.from({ length: 200 }, (_, i) => `v-${i}`);
    await sendWorkOrderVendorOffers(fakeDb(), actor, {
      workOrderId: "wo-1",
      vendorIds: [],
      marketplace: { enabled: true },
    });
    expect(rosterUpserts).toHaveLength(MAX_VENDORS_PER_SEND);
  });

  it("the manager's own named vendors take the slots before any stranger", async () => {
    matchedUserIds.value = Array.from({ length: 200 }, (_, i) => `v-${i}`);
    const named = Array.from({ length: MAX_VENDORS_PER_SEND }, (_, i) => `roster-${i}`);
    await sendWorkOrderVendorOffers(fakeDb(), actor, {
      workOrderId: "wo-1",
      vendorIds: named,
      marketplace: { enabled: true },
    });
    expect(rosterUpserts).toEqual([]);
  });
});
