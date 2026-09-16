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

  it("drops the request outright on purge, leaving every other row alone", async () => {
    // Delete from the Tours list is a different intent from Decline: the
    // manager is clearing history, so the row goes rather than turning into a
    // declined row that lingers in Past. Still only their own row, and never a
    // sibling request for the same slot.
    INQUIRY_PAYLOAD.push({
      id: "inq-sibling",
      kind: "tour",
      managerUserId: "mgr-attacker",
      email: "third@example.com",
      proposedStart: "2099-08-06T17:00:00.000Z",
      proposedEnd: "2099-08-06T17:30:00.000Z",
      status: "pending",
    });
    const res = await deleteTourInquiry(
      jsonRequest("http://localhost/api/portal-tour-inquiries/delete", {
        method: "POST",
        body: {
          id: "inq-own",
          purge: true,
          notifyTenant: false,
          start: "2099-08-06T17:00:00.000Z",
          end: "2099-08-06T17:30:00.000Z",
        },
      }),
    );
    expect(res.status).toBe(200);
    expect(notifyTenantTourRequestRemoved).not.toHaveBeenCalled();
    const upserted = UPSERT_CALLS[0] as { row_data?: { payload?: Record<string, unknown>[] } };
    const remaining = upserted.row_data?.payload ?? [];
    expect(remaining.map((row) => row.id)).toEqual(["inq-victim", "inq-sibling"]);
    expect(remaining.find((row) => row.id === "inq-sibling")?.status).toBe("pending");
  });

  it("declines and reports a skipped inbox copy instead of failing the whole decline", async () => {
    // A guest on account-deletion hold has a frozen resident inbox. The
    // notification helper now reports that copy as skipped; the route must
    // still decline the request and surface the skip in its response.
    vi.mocked(notifyTenantTourRequestRemoved).mockResolvedValueOnce({
      ok: true,
      skipped: false,
      inbox: { sent: false, error: "Could not create the resident property manager thread." },
    });
    const res = await deleteTourInquiry(
      jsonRequest("http://localhost/api/portal-tour-inquiries/delete", {
        method: "POST",
        body: { id: "inq-own" },
      }),
    );
    expect(res.status).toBe(200);
    const payload = (await res.json()) as { guestNotification?: { inbox?: { sent: boolean; error?: string } } };
    expect(payload.guestNotification?.inbox?.sent).toBe(false);
    expect(UPSERT_CALLS).toHaveLength(1);
    const upserted = UPSERT_CALLS[0] as { row_data?: { payload?: Record<string, unknown>[] } };
    expect(upserted.row_data?.payload?.find((row) => row.id === "inq-own")?.status).toBe("declined");
  });

  it("returns the notification failure reason when the guest email cannot be sent", async () => {
    vi.mocked(notifyTenantTourRequestRemoved).mockResolvedValueOnce({
      ok: false,
      skipped: false,
      error: "Email provider rejected the message.",
    });
    const res = await deleteTourInquiry(
      jsonRequest("http://localhost/api/portal-tour-inquiries/delete", {
        method: "POST",
        body: { id: "inq-own" },
      }),
    );
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error?: string }).error).toBe(
      "Could not notify the guest: Email provider rejected the message.",
    );
    expect(UPSERT_CALLS).toHaveLength(0);
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
