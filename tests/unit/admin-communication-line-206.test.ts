/**
 * Admin Communication on the PropLane line (206):
 *  - the "PropLane number" card shows the line from the one line decision (`resolveServiceLine`), never a client owner's
 *    old work number;
 *  - an Unassigned lead is answered from the line: the lead's phone is resolved on the server from the lead id, only a
 *    platform admin may do it, and STOP / opt-out is honoured exactly like every other send on the line.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LEAD_CONSTRAINTS, leadFakeDb } from "../helpers/lead-fake-db";

const mocks = vi.hoisted(() => ({
  admin: vi.fn(async (): Promise<{ userId: string } | { status: 401 | 403 }> => ({ userId: "admin-1" })),
  sendSms: vi.fn(async (..._args: unknown[]): Promise<Record<string, unknown>> => ({ sent: true, sid: "SMadmin1" })),
  cohort: vi.fn(async () => [{ userId: "mgr-ambika" }]),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: vi.fn(() => ({})) }));
vi.mock("@/lib/seo/public-catalog.server", () => ({ getCrawlPublicListings: vi.fn(async () => []) }));
vi.mock("@/lib/one-number/lead-extract.server", () => ({ extractLeadFieldsWithModel: vi.fn(async () => null) }));
vi.mock("@/lib/manager-sms-messages.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/manager-sms-messages.server")>()),
  logManagerSmsMessage: vi.fn(async () => true),
}));
vi.mock("@/lib/sms/manager-sms-contacts.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/sms/manager-sms-contacts.server")>()),
  upsertManagerSmsContact: vi.fn(async () => ({ ok: true })),
}));
vi.mock("@/lib/one-number/team-alerts.server", () => ({ alertWorkspaceTeam: vi.fn(async () => ({ sent: true })) }));
vi.mock("@/lib/claw-resident-messaging.server", () => ({ resolveMappedManagerContacts: mocks.cohort }));
vi.mock("@/lib/twilio", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/twilio")>()),
  sendSms: (...args: unknown[]) => mocks.sendSms(...args),
}));
vi.mock("@/lib/one-number/admin-leads-guard.server", () => ({ requirePlatformAdmin: () => mocks.admin() }));

import { fetchAdminSmsConversations } from "@/lib/manager-sms-messages.server";
import { sendAdminLeadReply } from "@/lib/one-number/admin-lead-reply.server";
import { POST as replyRoute } from "@/app/api/admin/unassigned-leads/[id]/reply/route";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

const LEAD_ID = "11111111-1111-4111-8111-111111111111";
const LINE = "+12066781909";

function world(extra: Record<string, Record<string, unknown>[]> = {}) {
  return leadFakeDb(
    {
      sms_runtime_config: [{ singleton: true, line_mode: "shared", shared_number_e164: LINE, shared_messaging_service_sid: "MGline" }],
      profiles: [{ id: "mgr-ambika", sms_from_number: "+18146793694", phone: "+18146793694" }],
      sms_unassigned_leads: [{ id: LEAD_ID, phone_key: "5106489423", status: "open", profile: {}, last_inbound_at: "2026-10-27T17:00:00Z", updated_at: "2026-10-27T17:00:00Z" }],
      sms_unassigned_lead_turns: [{ id: "t1", lead_id: LEAD_ID, direction: "inbound", body: "which rooms are free?", created_at: "2026-10-27T17:00:00Z" }],
      ...extra,
    },
    { constraints: LEAD_CONSTRAINTS },
  );
}

beforeEach(() => {
  mocks.admin.mockClear();
  mocks.admin.mockResolvedValue({ userId: "admin-1" });
  mocks.sendSms.mockClear();
  mocks.sendSms.mockResolvedValue({ sent: true, sid: "SMadmin1" });
});

describe("the PropLane number card", () => {
  it("shows the PropLane line, not the first manager in scope's own old number", async () => {
    const fake = world();
    const payload = await fetchAdminSmsConversations(fake.db);
    expect(payload.workNumber).toBe(LINE);
    expect(payload.workNumber).not.toBe("+18146793694");
  });

  it("shows no number when the line cannot be resolved, never the old one", async () => {
    const fake = world({ sms_runtime_config: [{ singleton: true, line_mode: "per_workspace" }] });
    const payload = await fetchAdminSmsConversations(fake.db);
    expect(payload.workNumber).toBeNull();
  });
});

describe("admin replies to an Unassigned lead from the PropLane line", () => {
  it("resolves the lead's phone from the lead id on the server, sends from the line and records the turn", async () => {
    const fake = world();
    const result = await sendAdminLeadReply(fake.db, { leadId: LEAD_ID, text: "Hi, this is PropLane. Room 6 is free Nov 1." });
    expect(result).toEqual({ ok: true, sid: "SMadmin1" });
    expect(mocks.sendSms).toHaveBeenCalledTimes(1);
    const [to, body, from] = mocks.sendSms.mock.calls[0] as [string, string, string];
    expect(to).toBe("+15106489423");
    expect(from).toBe(LINE);
    expect(body).toContain("Room 6 is free");
    const turns = fake.rows.sms_unassigned_lead_turns!;
    expect(turns.at(-1)).toMatchObject({ lead_id: LEAD_ID, direction: "outbound", body: "Hi, this is PropLane. Room 6 is free Nov 1." });
  });

  it("honours STOP / opt-out: the text is refused, nothing is recorded in the thread", async () => {
    mocks.sendSms.mockResolvedValue({ sent: false, error: "recipient_opted_out", providerAttempted: false });
    const fake = world();
    const before = fake.rows.sms_unassigned_lead_turns!.length;
    const result = await sendAdminLeadReply(fake.db, { leadId: LEAD_ID, text: "Still interested?" });
    expect(result).toEqual({ ok: false, status: 409, error: "That number has opted out of texts." });
    expect(fake.rows.sms_unassigned_lead_turns!.length).toBe(before);
  });

  it("refuses an empty text, an unknown lead and a lead that is no longer open, and sends nothing", async () => {
    const fake = world({ sms_unassigned_leads: [
      { id: LEAD_ID, phone_key: "5106489423", status: "assigned", profile: {}, last_inbound_at: "2026-10-27T17:00:00Z", updated_at: "2026-10-27T17:00:00Z" },
    ] });
    expect(await sendAdminLeadReply(fake.db, { leadId: LEAD_ID, text: "  " })).toMatchObject({ ok: false, status: 400 });
    expect(await sendAdminLeadReply(fake.db, { leadId: "99999999-9999-4999-8999-999999999999", text: "hi" })).toMatchObject({ ok: false, status: 404 });
    expect(await sendAdminLeadReply(fake.db, { leadId: LEAD_ID, text: "hi" })).toMatchObject({ ok: false, status: 409 });
    expect(mocks.sendSms).not.toHaveBeenCalled();
  });
});

describe("POST /api/admin/unassigned-leads/[id]/reply", () => {
  const call = (id: string, body: unknown) =>
    replyRoute(new Request("http://localhost/api/admin/unassigned-leads/x/reply", { method: "POST", body: JSON.stringify(body) }), {
      params: Promise.resolve({ id }),
    });

  it("refuses a non-admin and a signed-out caller before anything is read or sent", async () => {
    mocks.admin.mockResolvedValue({ status: 403 });
    expect((await call(LEAD_ID, { text: "hi" })).status).toBe(403);
    mocks.admin.mockResolvedValue({ status: 401 });
    expect((await call(LEAD_ID, { text: "hi" })).status).toBe(401);
    expect(mocks.sendSms).not.toHaveBeenCalled();
    expect(createSupabaseServiceRoleClient).not.toHaveBeenCalled();
  });

  it("never takes a phone from the body: only the lead id and the text matter", async () => {
    const fake = world();
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(fake.db);
    const res = await call(LEAD_ID, { text: "Hello from PropLane", to: "+19995550000", phone: "+19995550000", toPhone: "+19995550000" });
    expect(res.status).toBe(200);
    expect((mocks.sendSms.mock.calls[0] as unknown[])[0]).toBe("+15106489423");
  });

  it("rejects an id that is not a lead id", async () => {
    expect((await call("not-a-uuid", { text: "hi" })).status).toBe(404);
  });
});
