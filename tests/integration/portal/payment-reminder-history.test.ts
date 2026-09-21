import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/manager-route-guard.server", () => ({ requireManagerRouteUser: vi.fn() }));
vi.mock("@/lib/auth/admin-preview", () => ({ isAdminUser: vi.fn() }));
vi.mock("@/lib/payment-reminder-capability.server", () => ({ loadPaymentReminderChargeForActor: vi.fn() }));
vi.mock("@/lib/payment-reminder-history.server", () => ({ loadPaymentReminderHistory: vi.fn() }));

import { requireManagerRouteUser } from "@/lib/manager-route-guard.server";
import { isAdminUser } from "@/lib/auth/admin-preview";
import { loadPaymentReminderChargeForActor } from "@/lib/payment-reminder-capability.server";
import { loadPaymentReminderHistory } from "@/lib/payment-reminder-history.server";
import { GET } from "@/app/api/portal/payment-reminder-history/route";

const URL = "http://localhost/api/portal/payment-reminder-history?chargeId=charge-1";

describe("GET /api/portal/payment-reminder-history", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requireManagerRouteUser).mockResolvedValue({ userId: "co-manager", db: {} } as never);
    vi.mocked(isAdminUser).mockResolvedValue(false);
    vi.mocked(loadPaymentReminderChargeForActor).mockResolvedValue({
      charge: { id: "charge-1" } as never,
      ownerUserId: "workspace-owner",
      propertyId: "home-1",
    });
    vi.mocked(loadPaymentReminderHistory).mockResolvedValue([]);
  });

  it("does not query history for a charge outside the actor's workspace grant", async () => {
    vi.mocked(loadPaymentReminderChargeForActor).mockResolvedValue(null);
    const res = await GET(new Request(URL));
    expect(res.status).toBe(404);
    expect(loadPaymentReminderHistory).not.toHaveBeenCalled();
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });

  it("returns a scoped, uncached channel timeline", async () => {
    vi.mocked(loadPaymentReminderHistory).mockResolvedValue([{
      id: "occ-1", createdAt: "2026-09-13T00:00:00Z", subject: "Rent due",
      coveredChargeIds: ["charge-1"], channels: [{
        channel: "email", status: "submitted", effectiveStatus: "submitted", attempts: 1,
        submittedAt: "2026-09-13T00:01:00Z", updatedAt: "2026-09-13T00:01:00Z",
        providerReference: "resend-id", providerAcceptance: "confirmed", errorCode: null,
      }],
    }]);
    const res = await GET(new Request(`${URL}&occurrenceId=occ-1`));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.occurrences).toHaveLength(1);
    expect(body.ownerUserId).toBe("workspace-owner");
    expect(loadPaymentReminderHistory).toHaveBeenCalledWith(expect.objectContaining({
      actorUserId: "co-manager", ownerUserId: "workspace-owner", chargeId: "charge-1",
      occurrenceId: "occ-1", admin: false,
    }));
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });

  it("fails closed when the history store cannot be read", async () => {
    vi.mocked(loadPaymentReminderHistory).mockRejectedValue(new Error("database unavailable"));
    const res = await GET(new Request(URL));
    expect(res.status).toBe(503);
    expect(JSON.stringify(await res.json())).not.toContain("database unavailable");
  });
});
