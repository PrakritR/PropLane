import { beforeEach, describe, expect, it, vi } from "vitest";

const access = vi.hoisted(() => vi.fn());
const send = vi.hoisted(() => vi.fn());
const from = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth/vendor-api-access", () => ({ requireVendorApiAccess: access }));
vi.mock("@/lib/vendor-sponsored-outbound.server", () => ({ sendVendorSponsoredOutbound: send }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => ({ from }) }));
vi.mock("@/lib/inbox-attachments.server", () => ({ normalizeInboxAttachmentUrls: (value: unknown) => value }));
import { POST } from "@/app/api/vendor/send-inbox-message/route";

const id = "00000000-0000-4000-8000-000000000001";
function request(body: Record<string, unknown>) { return new Request("http://localhost/api/vendor/send-inbox-message", { method: "POST", body: JSON.stringify({ channel: "email", sendId: id, subject: "Update", text: "Body", ...body }) }); }

beforeEach(() => {
  vi.clearAllMocks();
  access.mockResolvedValue({ ok: true, actor: { userId: "vendor-1", email: "vendor@test.proplane", fullName: "Vendor" } });
  const q: Record<string, unknown> = {}; q.select = () => q; q.eq = () => q; q.then = (resolve: (value: unknown) => unknown) => resolve({ data: [] }); from.mockReturnValue(q);
  send.mockImplementation(async (_db: unknown, _actor: unknown, input: { preflight?: boolean; recipientUserId?: string; sendId: string }) => input.preflight ? { ok: true, delivery: "sending", providerMessageId: null } : { ok: true, delivery: "sent", providerMessageId: input.sendId });
});

describe("vendor sponsored fanout route", () => {
  it("dedupes after broadcast expansion and preserves stable child retry keys", async () => {
    const q: Record<string, unknown> = {}; q.select = () => q; q.eq = () => q; q.then = (resolve: (value: unknown) => unknown) => resolve({ data: [{ manager_user_id: "manager-1" }, { manager_user_id: "manager-2" }, { manager_user_id: "manager-1" }] }); from.mockReturnValue(q);
    await POST(request({ recipientUserIds: ["manager-1", "manager-1"], broadcastCategories: ["management"] }));
    await POST(request({ recipientUserIds: ["manager-1", "manager-1"], broadcastCategories: ["management"] }));
    const real = send.mock.calls.filter((call) => !call[2].preflight).map((call) => call[2].sendId);
    expect(real).toEqual([`${id}:manager-1`, `${id}:manager-2`, `${id}:manager-1`, `${id}:manager-2`]);
  });

  it("fails closed when management broadcast expansion cannot be read", async () => {
    const q: Record<string, unknown> = {}; q.select = () => q; q.eq = () => q; q.then = (resolve: (value: unknown) => unknown) => resolve({ data: null, error: { message: "database unavailable" } }); from.mockReturnValue(q);
    const response = await POST(request({ broadcastCategories: ["management"], includesAxisAdmin: true }));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ ok: false, error: "Could not resolve management recipients." });
    expect(send).not.toHaveBeenCalled();
  });

  it("refuses the entire fanout when one preflight recipient is unauthorized", async () => {
    send.mockImplementation(async (_db: unknown, _actor: unknown, input: { preflight?: boolean; recipientUserId?: string }) => input.preflight && input.recipientUserId === "manager-2" ? { ok: false, error: "recipient_unlinked" } : { ok: true, delivery: "sent", providerMessageId: null });
    const response = await POST(request({ recipientUserIds: ["manager-1", "manager-2"] }));
    expect(response.status).toBe(403);
    expect(send.mock.calls.filter((call) => !call[2].preflight)).toHaveLength(0);
  });

  it("returns each authorized delivery state without hiding mixed outcomes", async () => {
    send.mockImplementation(async (_db: unknown, _actor: unknown, input: { preflight?: boolean; recipientUserId?: string }) => {
      if (input.preflight) return { ok: true, delivery: "sending", providerMessageId: null };
      return { ok: true, delivery: input.recipientUserId === "manager-1" ? "sent" : input.recipientUserId === "manager-2" ? "sending" : "failed", providerMessageId: null };
    });
    const body = await (await POST(request({ recipientUserIds: ["manager-1", "manager-2", "manager-3"] }))).json();
    expect(body).toMatchObject({ ok: true, delivery: "mixed", results: [{ state: "sent" }, { state: "sending" }, { state: "failed" }] });
  });
});
