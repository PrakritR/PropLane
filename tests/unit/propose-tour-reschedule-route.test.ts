import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ auth: vi.fn(), admin: vi.fn(), notify: vi.fn(), from: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: () => ({ auth: { getUser: mocks.auth } }) }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => ({ from: mocks.from }) }));
vi.mock("@/lib/auth/admin-preview", () => ({ isAdminUser: mocks.admin }));
vi.mock("@/lib/tour-notification-delivery.server", () => ({ notifyTenantTourRescheduled: mocks.notify }));

import { POST } from "@/app/api/portal-tour-inquiries/propose-reschedule/route";

const oldStart = "2026-09-12T18:00:00.000Z";
const oldEnd = "2026-09-12T18:30:00.000Z";
const nextStart = "2026-09-13T18:00:00.000Z";
const nextEnd = "2026-09-13T18:30:00.000Z";

describe("propose tour reschedule notification outcome", () => {
  beforeEach(() => {
    mocks.auth.mockResolvedValue({ data: { user: { id: "manager-1" } } });
    mocks.admin.mockResolvedValue(false);
    mocks.notify.mockResolvedValue({ ok: false, skipped: false, error: "SMS was accepted, but its tour confirmation state was not saved.", sms: { accepted: true } });
    let stored: Record<string, unknown> = { payload: [{ id: "inquiry-1", kind: "tour", status: "pending", managerUserId: "manager-1", phone: "+12065550100", requestedWindows: [{ start: oldStart, end: oldEnd }], proposedStart: oldStart, proposedEnd: oldEnd }] };
    mocks.from.mockImplementation(() => {
      const q: Record<string, unknown> = {
        select: () => q, eq: () => q,
        maybeSingle: async () => ({ data: { row_data: stored }, error: null }),
        upsert: async (row: { row_data: Record<string, unknown> }) => { stored = row.row_data; return { error: null }; },
      };
      return q;
    });
  });

  it("keeps the saved window when an accepted SMS cannot save its reply state", async () => {
    const response = await POST(new Request("http://localhost/api/portal-tour-inquiries/propose-reschedule", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "inquiry-1", previousStart: oldStart, previousEnd: oldEnd, start: nextStart, end: nextEnd, deliverViaEmail: false, deliverViaSms: true }),
    }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, warning: "SMS was accepted, but its tour confirmation state was not saved." });
    expect(mocks.notify).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ proposedStart: nextStart }), expect.objectContaining({ proposalRecordId: "axis_admin_partner_inquiries_v1" }));
  });
});
