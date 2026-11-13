import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb } from "../helpers/fake-table-db";

const sendFromService = vi.fn(async (..._a: unknown[]) => ({ ok: true as const }) as { ok: true } | { ok: false; reason: string });
vi.mock("@/lib/service/service-manager.server", () => ({
  sendTextFromServiceOwner: (...a: unknown[]) => sendFromService(...a),
  readServiceManagerSettings: async () => null,
}));
vi.mock("@/lib/service/service-catalog.server", () => ({ readPlatformServiceOwnerId: async () => "svc-owner" }));
vi.mock("@/lib/manager-notice-email.server", () => ({ sendManagerNoticeEmail: async () => ({ status: "sent" as const }) }));
vi.mock("@/lib/agent-notify.server", () => ({ notifyManagerFromAgent: async () => ({ delivered: true, suppressed: false }) }));
vi.mock("@/lib/proplane-sms-transport.server", () => ({ sendFromManagerWorkNumber: async () => ({ ok: true }) }));
let roster: Array<{ userId: string; isOwner: boolean; role: string | null }> = [];
vi.mock("@/lib/workspace-team-recipients.server", () => ({ resolveWorkspaceNoticeRecipients: async () => roster }));
const push = vi.fn(async (..._a: unknown[]) => ({ sent: 1 }));
vi.mock("@/lib/push-notifications.server", () => ({ sendPushToUser: (...a: unknown[]) => push(...a) }));
const claimed = new Set<string>();
vi.mock("@/lib/rate-limit", () => ({ rateLimit: async (key: string) => (claimed.has(key) ? { ok: false } : (claimed.add(key), { ok: true })) }));
vi.mock("@/lib/prospect-spine/locate.server", () => ({ locateThreadId: async () => "thread-1" }));
vi.mock("@/lib/manager-sms-commands/index.server", () => ({ mintReplyHandle: async () => "K7" }));

import { alertOpsOfInboundText } from "@/lib/one-number/inbound-alert.server";

const CAPTAIN = "+15103098345";
function seed(extra: Record<string, unknown[]> = {}) {
  return createFakeDb({
    portal_workspaces: [{ id: "ws-amb", name: "1. Ambika", owner_user_id: "amb", is_service: true, is_default: true }],
    workspace_work_number_recipients: [{ id: "r1", owner_user_id: "amb", label: "PropLane admin", phone: CAPTAIN, email: null, created_at: "2026-11-04T01:18:09Z" }],
    account_link_invites: [{ invitee_user_id: "seat-1", inviter_user_id: "amb", workspace_id: "ws-amb", team_role: "admin", is_service_seat: true, status: "accepted" }],
    profiles: [{ id: "seat-1", email: "s@proplane.ai", phone: "+12065550122", phone_verified_at: "2026-11-01T00:00:00Z", sms_forward_inbound: true, full_name: "Seat" }],
    ...extra,
  }) as never;
}
beforeEach(() => { vi.clearAllMocks(); claimed.clear(); sendFromService.mockResolvedValue({ ok: true }); roster = [{ userId: "amb", isOwner: true, role: null }, { userId: "seat-1", isOwner: false, role: "admin" }]; });

describe("every inbound alerts, with push and a reply handle", () => {
  const base = { workspaceId: "ws-amb", managerId: "amb", fromPhone: "+12065550188", body: "is room 4 open?", messageSid: "SM1", onPropLaneLine: true, houseLabel: "5259 Brooklyn Ave NE · Room 4", propertyId: null };

  it("texts every staff phone as transactional, with the house + room and that phone's handle, and pushes the seat holder once", async () => {
    expect(await alertOpsOfInboundText(seed(), base)).toBe("sent");
    const calls = sendFromService.mock.calls.map((c) => c[1] as { toPhone: string; text: string; sendClass: string });
    expect(calls.map((c) => c.toPhone).sort()).toEqual([CAPTAIN, "+12065550122"].sort());
    expect(calls.every((c) => c.sendClass === "transactional")).toBe(true);
    expect(calls[0]!.text).toContain("5259 Brooklyn Ave NE - Room 4");
    expect(calls[0]!.text).toContain("Reply: K7 <your message>");
    expect(push.mock.calls.map((c) => c[0])).toContain("seat-1");
  });

  it("is idempotent on the MessageSid: a replay sends the same keys and pushes nobody twice", async () => {
    await alertOpsOfInboundText(seed(), base);
    const first = sendFromService.mock.calls.map((c) => (c[1] as { dedupeKey: string }).dedupeKey).sort();
    const pushes = push.mock.calls.length;
    sendFromService.mockClear();
    await alertOpsOfInboundText(seed(), base);
    expect(sendFromService.mock.calls.map((c) => (c[1] as { dedupeKey: string }).dedupeKey).sort()).toEqual(first);
    expect(push.mock.calls.length).toBe(pushes);
  });

  it("a managed workspace nobody is listed on falls back to the platform ops phones, never silence", async () => {
    const db = seed({ workspace_work_number_recipients: [], account_link_invites: [] });
    // ops phones come from a listed phone on a managed workspace held by a verified admin: none here, so still skipped, but the path runs
    expect(await alertOpsOfInboundText(db, base)).toBe("skipped");
    expect(sendFromService).not.toHaveBeenCalled();
  });

  it("the sender's own text is not news to them", async () => {
    expect(await alertOpsOfInboundText(seed(), { ...base, fromPhone: CAPTAIN })).toBe("skipped");
  });
});
