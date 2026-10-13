import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb } from "../helpers/fake-table-db";

const notifyManager = vi.fn(async (..._args: unknown[]) => ({ delivered: true, suppressed: false }));
vi.mock("@/lib/agent-notify.server", () => ({ notifyManagerFromAgent: (...args: unknown[]) => notifyManager(...args) }));
const sendText = vi.fn(async (..._args: unknown[]) => ({ ok: true as const }));
vi.mock("@/lib/proplane-sms-transport.server", () => ({ sendFromManagerWorkNumber: (...args: unknown[]) => sendText(...args) }));
vi.mock("@/lib/sms/manager-number-provisioning.server", () => ({
  resolveWorkspaceSendLine: async () => ({ phoneNumber: "+12065550100", numberId: "line-1" }),
}));
const sendEmail = vi.fn(async (..._args: unknown[]) => ({ status: "sent" as const }));
vi.mock("@/lib/manager-notice-email.server", () => ({ sendManagerNoticeEmail: (...args: unknown[]) => sendEmail(...args) }));
vi.mock("@/lib/communication/manager-assistant-workspace.server", () => ({
  resolveManagerAssistantWorkspace: async () => ({ workspaceId: "ws-1" }),
  assistantWorkspaceForThreadId: () => ({}),
  resolveManagerAssistantThreadWorkspace: async () => ({}),
}));

let actor: { id: string } | null = { id: "owner-1" };
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({ auth: { getUser: async () => ({ data: { user: actor } }) } }),
}));
let fake = createFakeDb({ workspace_work_number_recipients: [] });
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => fake }));
let manageable = new Set<string>(["owner-1"]);
vi.mock("@/lib/auth/co-manager-team-invite.server", () => ({ teamInviteOwnerIdsForActor: async () => manageable }));

import { DELETE, GET, POST } from "@/app/api/pro/work-number-recipients/route";
import { notifyPropertyScopedManagersFromAgent } from "@/lib/co-manager-notification-recipients.server";
import { parseWorkNumberRecipientInput } from "@/lib/work-number-recipients.server";

const json = (body: unknown, method = "POST") =>
  new Request("http://localhost/api/pro/work-number-recipients", { method, body: JSON.stringify(body), headers: { "content-type": "application/json" } });

beforeEach(() => {
  fake = createFakeDb({
    workspace_work_number_recipients: [{ id: "r1", owner_user_id: "owner-1", label: "Mrinaal", phone: "+12065554411", email: "m@example.com", created_by: "owner-1", created_at: "2026-10-12T00:00:00Z" }],
    // enough for the owner-only recipient resolution used by the fan-out
    portal_workspaces: [], manager_property_records: [], account_link_invites: [],
  });
  actor = { id: "owner-1" };
  manageable = new Set(["owner-1"]);
  notifyManager.mockClear(); sendText.mockClear(); sendEmail.mockClear();
});

describe("parseWorkNumberRecipientInput", () => {
  it("normalises the phone to E.164 and needs a name and one contact", () => {
    expect(parseWorkNumberRecipientInput({ label: "Sharad", phone: "(425) 555-0199" })).toEqual({ ok: true, label: "Sharad", phone: "+14255550199", email: null });
    expect(parseWorkNumberRecipientInput({ label: "", phone: "4255550199" })).toMatchObject({ ok: false });
    expect(parseWorkNumberRecipientInput({ label: "X" })).toMatchObject({ ok: false });
    expect(parseWorkNumberRecipientInput({ label: "X", phone: "12" })).toMatchObject({ ok: false });
    expect(parseWorkNumberRecipientInput({ label: "X", email: "nope" })).toMatchObject({ ok: false });
  });
});

describe("/api/pro/work-number-recipients", () => {
  it("401 without a session", async () => {
    actor = null;
    expect((await GET(new Request("http://localhost/api/pro/work-number-recipients"))).status).toBe(401);
  });
  it("403 for a teammate without Team edit under the named owner", async () => {
    actor = { id: "mate-1" };
    manageable = new Set(["mate-1"]);
    const res = await POST(json({ ownerUserId: "owner-1", label: "A", phone: "2065550101" }));
    expect(res.status).toBe(403);
    expect(fake.tables.workspace_work_number_recipients).toHaveLength(1);
  });
  it("lets a teammate with Team edit add for that owner, and the owner delete", async () => {
    actor = { id: "mate-1" };
    manageable = new Set(["mate-1", "owner-1"]);
    const res = await POST(json({ ownerUserId: "owner-1", label: "Priya", phone: "2065550101" }));
    expect(res.status).toBe(200);
    const row = fake.tables.workspace_work_number_recipients!.at(-1)!;
    expect(row).toMatchObject({ owner_user_id: "owner-1", label: "Priya", phone: "+12065550101", created_by: "mate-1" });
    actor = { id: "owner-1" };
    expect((await DELETE(json({ id: "r1" }, "DELETE"))).status).toBe(200);
    expect(fake.tables.workspace_work_number_recipients!.some((r) => r.id === "r1")).toBe(false);
  });
  it("400 for a person with no phone or email", async () => {
    expect((await POST(json({ label: "Nobody" }))).status).toBe(400);
  });
});

describe("fan-out to extra recipients", () => {
  it("texts from the owner's work number and emails from the work email, with no Assistant thread for them", async () => {
    await notifyPropertyScopedManagersFromAgent(fake as never, {
      ownerManagerUserId: "owner-1",
      propertyId: null,
      module: "calendar",
      subject: "New Airbnb booking",
      text: "full text",
      externalText: "New Airbnb booking · House · Room 9",
      url: "/portal/bookings/x/overview",
      idempotencyKey: "evt:1",
    });
    expect(notifyManager).toHaveBeenCalledTimes(1);
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(sendText.mock.calls[0]![0]).toMatchObject({ managerUserId: "owner-1", to: "+12065554411", fromNumber: "+12065550100" });
    expect(String((sendText.mock.calls[0]![0] as { text: string }).text)).toContain("New Airbnb booking · House · Room 9");
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail.mock.calls[0]![1]).toMatchObject({ toEmail: "m@example.com", ownerUserId: "owner-1" });
  });
  it("skips the extras when the owner was the actor", async () => {
    await notifyPropertyScopedManagersFromAgent(fake as never, {
      ownerManagerUserId: "owner-1", propertyId: null, module: "calendar", subject: "s", text: "t", excludeUserIds: ["owner-1"],
    });
    expect(sendText).not.toHaveBeenCalled();
  });
});
