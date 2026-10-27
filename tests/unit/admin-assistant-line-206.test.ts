/**
 * A text from a platform admin's verified phone to the PropLane line is that admin talking to their OWN PropLane
 * Assistant: it is never filed as an Unassigned lead, it is mirrored into the Assistant thread keyed by that admin, and
 * another admin never sees it. Anyone who is not (provably) an admin is routed exactly as before.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SharedLineConfig } from "@/lib/one-number/contracts";
import { fakeSharedLineDb, type FakeRow } from "../helpers/shared-line-fake-db";
import { leadFakeDb } from "../helpers/lead-fake-db";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/one-number/send.server", () => ({ sendSharedLineMessage: vi.fn(async () => ({ ok: true as const, messageSid: "SMout", segments: 1 })) }));
vi.mock("@/lib/one-number/team-alerts.server", () => ({ alertWorkspaceTeam: vi.fn(async () => ({ sent: true })) }));
const unassigned = vi.hoisted(() => vi.fn(async () => ({ leadId: "lead-1" as string | null, reply: "Welcome! Budget?" as string | null, assignedWorkspaceId: null as string | null })));
vi.mock("@/lib/one-number/onboarding/unknown-sender.server", () => ({ handleUnknownSenderInbound: unassigned }));

import { handleSharedLineInbound } from "@/lib/one-number/inbound-seam.server";
import { appendSmsTurnToManagerAssistantThread, mirrorManagerOwnOutboxToAssistantThread } from "@/lib/sms/manager-assistant-thread-mirror.server";
import { loadAdminOwnAssistantThread } from "@/lib/communication/admin-assistant-thread.server";
import { adminInboxMessageToThread } from "@/lib/admin-inbox-threads";

const VERIFIED = "2026-10-01T00:00:00.000Z";
const PRAKRIT_PHONE = "+15103098345";
const AARAV_PHONE = "+14155550177";
const MANAGER_PHONE = "+12065550142";
const SERVICE_OWNER = "svc-owner";
const SERVICE_WS = "ws-service";

const config = (): SharedLineConfig => ({ mode: "shared", sharedNumber: "+12066781909", messagingServiceSid: "MGshared", pilotWorkspaceIds: [] });

function world(extra: Record<string, FakeRow[]> = {}) {
  return fakeSharedLineDb({
    platform_service_settings: [{ singleton: true, owner_user_id: SERVICE_OWNER }],
    portal_workspaces: [
      { id: SERVICE_WS, name: "PropLane", owner_user_id: SERVICE_OWNER, is_default: true },
      { id: "ws-a", name: "Brooklyn Homes", owner_user_id: "owner-a", is_default: true },
    ],
    manager_property_records: [{ id: "prop-a1", manager_user_id: "owner-a", workspace_id: "ws-a", row_data: { buildingName: "5259 Brooklyn" } }],
    profiles: [
      { id: "admin-prakrit", email: "p@x.com", phone: PRAKRIT_PHONE, phone_verified_at: VERIFIED },
      { id: "admin-aarav", email: "a@x.com", phone: AARAV_PHONE, phone_verified_at: VERIFIED },
      { id: "owner-a", email: "o@x.com", phone: MANAGER_PHONE, phone_verified_at: VERIFIED },
    ],
    profile_roles: [
      { user_id: "admin-prakrit", role: "admin" },
      { user_id: "admin-aarav", role: "admin" },
      { user_id: "owner-a", role: "manager" },
    ],
    ...extra,
  });
}

const run = (db: never, fromPhone: string, body = "which rooms are free in nov across ambika") =>
  handleSharedLineInbound(db, { config: config(), fromPhone, body, messageSid: "SM1", mediaCount: 0, phoneKey: fromPhone.replace(/\D/g, "").slice(-10) });

beforeEach(() => unassigned.mockClear());

describe("an admin's text to the PropLane line", () => {
  it("continues into the manager pipeline as the PropLane service owner, and files no Unassigned lead", async () => {
    const { db } = world();
    expect(await run(db, PRAKRIT_PHONE)).toEqual({
      kind: "continue",
      owned: { managerId: SERVICE_OWNER, workspaceId: SERVICE_WS, messagingServiceSid: "MGshared" },
    });
    expect(unassigned).not.toHaveBeenCalled();
  });

  it("does the same for a second admin (each is recognised by their own phone)", async () => {
    const { db } = world();
    expect(await run(db, AARAV_PHONE)).toMatchObject({ kind: "continue", owned: { managerId: SERVICE_OWNER } });
    expect(unassigned).not.toHaveBeenCalled();
  });

  it("an unverified admin phone is a stranger: the lead path, as today", async () => {
    const { db } = world({
      profiles: [{ id: "admin-prakrit", email: "p@x.com", phone: PRAKRIT_PHONE, phone_verified_at: null }],
    });
    const result = await run(db, PRAKRIT_PHONE);
    expect(result.kind).toBe("handled");
    expect(unassigned).toHaveBeenCalled();
  });

  it("a phone claimed by two verified accounts is nobody (ambiguous = today's behaviour)", async () => {
    const { db } = world({
      profiles: [
        { id: "admin-prakrit", email: "p@x.com", phone: PRAKRIT_PHONE, phone_verified_at: VERIFIED },
        { id: "someone-else", email: "s@x.com", phone: PRAKRIT_PHONE, phone_verified_at: VERIFIED },
      ],
    });
    const result = await run(db, PRAKRIT_PHONE);
    expect(result.kind).toBe("handled");
    expect(unassigned).toHaveBeenCalled();
  });

  it("an unreadable role table means no admin recognition, never more access", async () => {
    const { db } = fakeSharedLineDb(
      {
        platform_service_settings: [{ singleton: true, owner_user_id: SERVICE_OWNER }],
        portal_workspaces: [{ id: SERVICE_WS, name: "PropLane", owner_user_id: SERVICE_OWNER, is_default: true }],
        profiles: [{ id: "admin-prakrit", email: "p@x.com", phone: PRAKRIT_PHONE, phone_verified_at: VERIFIED }],
      },
      { broken: ["profile_roles"] },
    );
    const result = await run(db, PRAKRIT_PHONE);
    expect(result.kind).toBe("handled");
    expect(unassigned).toHaveBeenCalled();
  });

  it("a verified non-admin (a property manager) is routed exactly as before", async () => {
    const { db } = world();
    const result = await run(db, MANAGER_PHONE, "any update on the sink");
    expect(result).toEqual({ kind: "continue", owned: { managerId: "owner-a", workspaceId: "ws-a", messagingServiceSid: "MGshared" } });
  });
});

describe("the admin's own Assistant thread", () => {
  function threads() {
    return leadFakeDb({
      portal_workspaces: [
        { id: SERVICE_WS, owner_user_id: SERVICE_OWNER, is_default: true },
        { id: "ws-prakrit", owner_user_id: "admin-prakrit", is_default: true },
        { id: "ws-aarav", owner_user_id: "admin-aarav", is_default: true },
      ],
      portal_inbox_thread_records: [
        { id: "agent_notice_admin-prakrit", scope: "axis_portal_inbox_manager_v1", owner_user_id: "admin-prakrit", thread_type: "agent_notice", row_data: { id: "agent_notice_admin-prakrit", folder: "inbox", from: "PropLane Assistant", messages: [] }, updated_at: "2026-10-27T10:00:00Z" },
        { id: "agent_notice_admin-aarav", scope: "axis_portal_inbox_manager_v1", owner_user_id: "admin-aarav", thread_type: "agent_notice", row_data: { id: "agent_notice_admin-aarav", folder: "inbox", from: "PropLane Assistant", messages: [] }, updated_at: "2026-10-27T10:00:00Z" },
      ],
    });
  }
  const bodiesOf = (fake: ReturnType<typeof threads>, id: string) =>
    ((fake.rows.portal_inbox_thread_records!.find((r) => r.id === id)?.row_data as { messages?: Array<{ body: string }> })?.messages ?? []).map((m) => m.body);

  it("the mirror writes an admin's text into THEIR default-workspace Assistant thread, even on the service owner's workspace line", async () => {
    const fake = threads();
    const result = await appendSmsTurnToManagerAssistantThread(fake.db, {
      ownerUserId: "admin-prakrit",
      workspaceId: null,
      messageId: "sms_in_SM1",
      author: "manager",
      body: "which rooms are free in nov across ambika",
    });
    expect(result).toMatchObject({ ok: true, threadId: "agent_notice_admin-prakrit", appended: true });
    expect(bodiesOf(fake, "agent_notice_admin-prakrit")).toEqual(["which rooms are free in nov across ambika"]);
  });

  it("two admins are isolated: Aarav's text lands in Aarav's thread and Prakrit's read never contains it", async () => {
    const fake = threads();
    await appendSmsTurnToManagerAssistantThread(fake.db, { ownerUserId: "admin-aarav", workspaceId: null, messageId: "sms_in_SM2", author: "manager", body: "aarav private question" });
    await appendSmsTurnToManagerAssistantThread(fake.db, { ownerUserId: "admin-prakrit", workspaceId: null, messageId: "sms_in_SM3", author: "manager", body: "prakrit question" });
    expect(bodiesOf(fake, "agent_notice_admin-aarav")).toEqual(["aarav private question"]);
    expect(bodiesOf(fake, "agent_notice_admin-prakrit")).toEqual(["prakrit question"]);

    const prakrit = await loadAdminOwnAssistantThread(fake.db, "admin-prakrit", { ensure: async () => undefined });
    expect(prakrit?.id).toBe("agent_notice_admin-prakrit");
    expect(JSON.stringify(prakrit)).toContain("prakrit question");
    expect(JSON.stringify(prakrit)).not.toContain("aarav private question");

    const aarav = await loadAdminOwnAssistantThread(fake.db, "admin-aarav", { ensure: async () => undefined });
    expect(JSON.stringify(aarav)).toContain("aarav private question");
    expect(JSON.stringify(aarav)).not.toContain("prakrit question");
  });

  it("the assistant's reply on the PropLane line lands in the admin's own thread, not a chat in the service owner's workspace", async () => {
    const fake = leadFakeDb({
      portal_workspaces: [
        { id: SERVICE_WS, owner_user_id: SERVICE_OWNER, is_default: true },
        { id: "ws-prakrit", owner_user_id: "admin-prakrit", is_default: true },
      ],
      profiles: [{ id: "admin-prakrit", phone: PRAKRIT_PHONE }],
      profile_roles: [{ user_id: "admin-prakrit", role: "admin" }],
      manager_sms_numbers: [{ manager_user_id: SERVICE_OWNER, phone_number: "+12066781909", workspace_id: SERVICE_WS }],
      portal_inbox_thread_records: [
        { id: "agent_notice_admin-prakrit", scope: "axis_portal_inbox_manager_v1", owner_user_id: "admin-prakrit", row_data: { id: "agent_notice_admin-prakrit", messages: [] }, updated_at: "2026-10-27T10:00:00Z" },
      ],
    });
    const row = { id: "out-1", manager_user_id: SERVICE_OWNER, actor_user_id: "admin-prakrit", recipient_phone: PRAKRIT_PHONE, body: "Ambika has 4 rooms free in November.", purpose: "manager_conversation", counterparty_role: "manager" };
    expect(await mirrorManagerOwnOutboxToAssistantThread(fake.db, row, "+12066781909")).toBe("mirrored");
    expect(bodiesOf(fake as never, "agent_notice_admin-prakrit")).toEqual(["Ambika has 4 rooms free in November."]);
    expect(fake.rows.portal_inbox_thread_records!.map((r) => r.id)).toEqual(["agent_notice_admin-prakrit"]);
  });

  it("the read is keyed to the viewer: a user with no thread of their own reads nothing, never someone else's", async () => {
    const fake = threads();
    expect(await loadAdminOwnAssistantThread(fake.db, "admin-nobody", { ensure: async () => undefined })).toBeNull();
    expect(await loadAdminOwnAssistantThread(fake.db, "", { ensure: async () => undefined })).toBeNull();
  });

  it("a row whose owner is not the viewer is never returned even under the viewer's id", async () => {
    const fake = leadFakeDb({
      portal_inbox_thread_records: [
        { id: "agent_notice_admin-prakrit", scope: "axis_portal_inbox_manager_v1", owner_user_id: "admin-aarav", row_data: { id: "agent_notice_admin-prakrit", messages: [{ body: "leaked" }] } },
      ],
    });
    expect(await loadAdminOwnAssistantThread(fake.db, "admin-prakrit", { ensure: async () => undefined })).toBeNull();
  });
});

describe("admin Communication never draws another admin's Assistant chat", () => {
  it("the admin adapter drops an Assistant thread that is not the viewer's", async () => {
    const { createAdminInboxAdapter } = await import("@/components/portal/communication-adapters/admin-inbox-adapter");
    const adapter = createAdminInboxAdapter({ smsUiEnabled: true });
    const mine = { id: "agent_notice_admin-prakrit", folder: "inbox", from: "PropLane Assistant", email: "", subject: "", preview: "", time: "", unread: false };
    const theirs = { ...mine, id: "agent_notice_admin-aarav" };
    const mail = adminInboxMessageToThread({ id: "m1", name: "Sam", email: "sam@example.test", topic: "Hi", body: "Hello", createdAt: "2026-10-27T10:00:00Z", read: false, folder: "inbox", senderRole: "manager", thread: [] });
    const out = adapter.buildListThreads([theirs, mail, mine] as never, { viewerId: "admin-prakrit", workspace: null, smsUiEnabled: true });
    expect(out.map((t) => t.id)).toEqual(["m1", "agent_notice_admin-prakrit"]);
    expect(adapter.buildListThreads([mine] as never, { viewerId: null, workspace: null, smsUiEnabled: true })).toEqual([]);
    expect(adapter.pinsAssistant).toBe(true);
    expect(adapter.assistantWorkspace).toEqual({ id: "", isDefault: true });
  });
});
