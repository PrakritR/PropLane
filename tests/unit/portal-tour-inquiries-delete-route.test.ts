import { beforeEach, describe, expect, it, vi } from "vitest";
import { jsonRequest } from "../helpers/api-request";

const getUser = vi.fn();
let INQUIRY_PAYLOAD: Record<string, unknown>[];
let UPSERT_CALLS: unknown[];

vi.mock("@/lib/auth/admin-preview", () => ({ isAdminUser: async () => false }));
vi.mock("@/lib/tour-notification-delivery.server", () => ({
  notifyTenantTourRequestRemoved: vi.fn().mockResolvedValue({ ok: true, skipped: false }),
}));
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({ auth: { getUser } }),
}));
vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: () => makeServiceClient(),
}));

import { POST as deleteTourInquiry } from "@/app/api/portal-tour-inquiries/delete/route";
import { notifyTenantTourRequestRemoved } from "@/lib/tour-notification-delivery.server";

function makeServiceClient() {
  return {
    from(table: string) {
      if (table === "portal_schedule_records") {
        const builder: Record<string, unknown> = {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockImplementation((column: string, value: string) => {
            if (column === "id" && value === "axis_admin_partner_inquiries_v1") {
              builder.maybeSingle = vi.fn().mockResolvedValue({
                data: { row_data: { payload: INQUIRY_PAYLOAD } },
                error: null,
              });
            }
            if (column === "record_type") {
              builder.then = (resolve: (v: unknown) => unknown) =>
                Promise.resolve({ data: [], error: null }).then(resolve);
            }
            return builder;
          }),
          maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
          upsert: vi.fn().mockImplementation((row: unknown) => {
            UPSERT_CALLS.push(row);
            return Promise.resolve({ error: null });
          }),
          delete: vi.fn().mockReturnValue({
            in: vi.fn().mockResolvedValue({ error: null }),
          }),
        };
        return builder;
      }
      return {};
    },
  };
}

describe("POST /api/portal-tour-inquiries/delete", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    UPSERT_CALLS = [];
    INQUIRY_PAYLOAD = [
      {
        id: "inq-victim",
        kind: "tour",
        managerUserId: "mgr-victim",
        email: "guest@example.com",
      },
      {
        id: "inq-own",
        kind: "tour",
        managerUserId: "mgr-attacker",
        email: "other@example.com",
      },
    ];
    getUser.mockResolvedValue({ data: { user: { id: "mgr-attacker" } }, error: null });
  });

  it("denies deleting another manager's tour inquiry from the global singleton", async () => {
    const res = await deleteTourInquiry(
      jsonRequest("http://localhost/api/portal-tour-inquiries/delete", {
        method: "POST",
        body: { id: "inq-victim" },
      }),
    );
    expect(res.status).toBe(403);
    expect(UPSERT_CALLS).toHaveLength(0);
  });

  it("allows a manager to delete their own tour inquiry", async () => {
    const res = await deleteTourInquiry(
      jsonRequest("http://localhost/api/portal-tour-inquiries/delete", {
        method: "POST",
        body: { id: "inq-own" },
      }),
    );
    expect(res.status).toBe(200);
    expect(notifyTenantTourRequestRemoved).toHaveBeenCalled();
    expect(UPSERT_CALLS).toHaveLength(1);
    const upserted = UPSERT_CALLS[0] as { row_data?: { payload?: Record<string, unknown>[] } };
    const remaining = upserted.row_data?.payload ?? [];
    // A cancelled tour is DECLINED, not erased. The guest was told this tour existed, so the
    // record stays and carries its outcome; hard-deleting it would lose the fact that it was ever
    // booked. Another manager's inquiry is untouched either way.
    expect(remaining.some((row) => row.id === "inq-victim")).toBe(true);
    const own = remaining.find((row) => row.id === "inq-own");
    expect(own).toBeTruthy();
    expect(own?.status).toBe("declined");
  });

  it("skips guest notification when notifyTenant is false", async () => {
    const res = await deleteTourInquiry(
      jsonRequest("http://localhost/api/portal-tour-inquiries/delete", {
        method: "POST",
        body: { id: "inq-own", notifyTenant: false },
      }),
    );
    expect(res.status).toBe(200);
    expect(notifyTenantTourRequestRemoved).not.toHaveBeenCalled();
  });
});
