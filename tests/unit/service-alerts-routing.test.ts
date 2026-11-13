import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb } from "../helpers/fake-table-db";

const sendFromService = vi.fn(async (..._a: unknown[]) => ({ ok: true as const }) as { ok: true } | { ok: false; reason: string });
vi.mock("@/lib/service/service-manager.server", () => ({
  sendTextFromServiceOwner: (...a: unknown[]) => sendFromService(...a),
  readServiceManagerSettings: async () => null,
}));
vi.mock("@/lib/service/service-catalog.server", () => ({ readPlatformServiceOwnerId: async () => "svc-owner" }));
const sendEmail = vi.fn(async (..._a: unknown[]) => ({ status: "sent" as const }));
vi.mock("@/lib/manager-notice-email.server", () => ({ sendManagerNoticeEmail: (...a: unknown[]) => sendEmail(...a) }));
const notifyManager = vi.fn(async (..._a: unknown[]) => ({ delivered: true, suppressed: false }));
vi.mock("@/lib/agent-notify.server", () => ({ notifyManagerFromAgent: (...a: unknown[]) => notifyManager(...a) }));
const ownWallet = vi.fn(async (..._a: unknown[]) => ({ ok: true as const }));
vi.mock("@/lib/proplane-sms-transport.server", () => ({ sendFromManagerWorkNumber: (...a: unknown[]) => ownWallet(...a) }));
vi.mock("@/lib/sms/manager-number-provisioning.server", () => ({ resolveWorkspaceSendLine: async () => ({ phoneNumber: "+12065550100", numberId: "l1" }) }));
// The roster: who the seat grants put on the event (the real matrix is covered by its own tests).
let roster: Array<{ userId: string; isOwner: boolean; role: string | null }> = [];
vi.mock("@/lib/workspace-team-recipients.server", () => ({ resolveWorkspaceNoticeRecipients: async () => roster }));

import { notifyServiceAlertTargets, resolveServiceAlertTargets, staffSeatUserIds, mergeAlertPhones } from "@/lib/service/service-alert-targets.server";
import { notifyWorkNumberRecipients } from "@/lib/work-number-recipients.server";
import { isManagerRecipientSmsPurpose, ensureTeamNoticeScopedSmsConsent, ALERT_PHONE_SMS_PURPOSE, SERVICE_ALERT_PHONE_SMS_PURPOSE } from "@/lib/sms/team-notice-consent.server";

const CAPTAIN = "+15103098345";
function seed(overrides: Record<string, unknown[]> = {}) {
  return createFakeDb({
    portal_workspaces: [
      { id: "ws-amb", name: "1. Ambika", owner_user_id: "amb", is_service: true, is_default: true },
      { id: "ws-vin", name: "2. Vinod", owner_user_id: "vin", is_service: true, is_default: true },
      { id: "ws-self", name: "Self serve", owner_user_id: "self", is_service: false, is_default: true },
    ],
    workspace_work_number_recipients: [
      { id: "r1", owner_user_id: "amb", label: "PropLane admin", phone: CAPTAIN, email: null, created_at: "2026-11-04T01:18:09Z" },
      { id: "r2", owner_user_id: "vin", label: "PropLane admin", phone: CAPTAIN, email: null, created_at: "2026-11-04T01:18:09Z" },
      { id: "r3", owner_user_id: "self", label: "Mom", phone: "+12065550111", email: "mom@example.com", created_at: "2026-11-04T01:18:09Z" },
    ],
    account_link_invites: [
      // a PropLane-issued seat on Vinod's workspace only
      { invitee_user_id: "seat-v", inviter_user_id: "vin", workspace_id: "ws-vin", team_role: "viewer", is_service_seat: true, status: "accepted" },
      // a seat on BOTH workspaces
      { invitee_user_id: "seat-both", inviter_user_id: "vin", workspace_id: "ws-vin", team_role: "admin", is_service_seat: true, status: "accepted" },
      { invitee_user_id: "seat-both", inviter_user_id: "amb", workspace_id: "ws-amb", team_role: "admin", is_service_seat: true, status: "accepted" },
      // a limited seat the CLIENT wrote: never staff
      { invitee_user_id: "client-friend", inviter_user_id: "vin", workspace_id: "ws-vin", team_role: "viewer", is_service_seat: false, status: "accepted" },
    ],
    profiles: [
      { id: "seat-v", email: "seatv@proplane.ai", phone: "+12065550122", phone_verified_at: "2026-11-01T00:00:00Z", sms_forward_inbound: true, full_name: "Seat V" },
      { id: "seat-both", email: "both@proplane.ai", phone: "+12065550133", phone_verified_at: "2026-11-01T00:00:00Z", sms_forward_inbound: true, full_name: "Seat Both" },
      { id: "client-friend", email: "f@example.com", phone: "+12065550144", phone_verified_at: "2026-11-01T00:00:00Z", sms_forward_inbound: true, full_name: "Friend" },
    ],
    ...overrides,
  }) as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  sendFromService.mockResolvedValue({ ok: true });
  roster = [];
});

describe("staff seats and alert phones", () => {
  it("only a PropLane-issued or operator seat of THIS workspace is staff; the client's own limited seat never is", () => {
    const rows = [
      { invitee_user_id: "a", workspace_id: "ws-1", team_role: "viewer", is_service_seat: true },
      { invitee_user_id: "b", workspace_id: "ws-1", team_role: "viewer", is_service_seat: false },
      { invitee_user_id: "c", workspace_id: "ws-2", team_role: "admin", is_service_seat: true },
      { invitee_user_id: "d", workspace_id: null, team_role: "admin", is_service_seat: false },
      { invitee_user_id: "e", workspace_id: "ws-1", team_role: "property_owner", is_service_seat: true },
    ];
    expect(staffSeatUserIds(rows, { workspaceId: "ws-1", defaultWorkspaceId: null })).toEqual(["a"]);
    // A seat the client wrote is never staff, even an Admin one, unless PropLane itself owns the workspace.
    expect(staffSeatUserIds(rows, { workspaceId: "ws-9", defaultWorkspaceId: "ws-9" })).toEqual([]);
    expect(staffSeatUserIds(rows, { workspaceId: "ws-9", defaultWorkspaceId: "ws-9", ownedByServiceOwner: true })).toEqual(["d"]);
  });

  it("one entry per number, a listed number wins over a seat holder's", () => {
    const merged = mergeAlertPhones(
      [{ phone: "(510) 309-8345", userId: null, label: "admin", sendClass: "transactional" }],
      [{ phone: CAPTAIN, userId: "u1", label: "captain seat", sendClass: "automated" }, { phone: "+12065550122", userId: "u2", label: "seat", sendClass: "automated" }],
    );
    expect(merged.map((p) => [p.phone, p.userId])).toEqual([[CAPTAIN, null], ["+12065550122", "u2"]]);
  });

  it("derives recipients from memberships on the server: Vinod's workspace reaches Vinod's seats, never a seat that is only on Ambika's", async () => {
    roster = [{ userId: "vin", isOwner: true, role: null }, { userId: "seat-v", isOwner: false, role: "viewer" }, { userId: "seat-both", isOwner: false, role: "admin" }, { userId: "client-friend", isOwner: false, role: "viewer" }];
    const vin = await resolveServiceAlertTargets(seed(), { workspaceId: "ws-vin", module: "inbox" });
    expect(vin?.phones.map((p) => p.phone).sort()).toEqual([CAPTAIN, "+12065550122", "+12065550133"].sort());
    expect(vin?.phones.some((p) => p.phone === "+12065550144")).toBe(false); // the client's friend is not staff
    // Ambika's workspace: seat-v holds no seat there
    roster = [{ userId: "amb", isOwner: true, role: null }, { userId: "seat-both", isOwner: false, role: "admin" }];
    const amb = await resolveServiceAlertTargets(seed(), { workspaceId: "ws-amb", module: "inbox" });
    expect(amb?.phones.map((p) => p.phone).sort()).toEqual([CAPTAIN, "+12065550133"].sort());
  });

  it("a seat that the grants do not put on the event hears nothing (module/role respected)", async () => {
    roster = [{ userId: "vin", isOwner: true, role: null }]; // the matrix dropped both seats
    const t = await resolveServiceAlertTargets(seed(), { workspaceId: "ws-vin", module: "financials" });
    expect(t?.phones.map((p) => p.phone)).toEqual([CAPTAIN]);
  });

  it("a self-serve workspace is not managed: nothing resolves and nothing is sent", async () => {
    expect(await resolveServiceAlertTargets(seed(), { workspaceId: "ws-self" })).toBeNull();
    expect(await notifyServiceAlertTargets(seed(), { workspaceId: "ws-self", smsText: "x", emailSubject: "s", emailText: "t", idempotencyKey: "k" })).toBeNull();
    expect(sendFromService).not.toHaveBeenCalled();
  });
});

describe("billing: a managed workspace's alerts are PropLane's own operations", () => {
  it("texts through the platform service owner (never the client's wallet), the seat holder routine-class, the admin phone at once", async () => {
    roster = [{ userId: "vin", isOwner: true, role: null }, { userId: "seat-v", isOwner: false, role: "viewer" }];
    const out = await notifyServiceAlertTargets(seed(), { workspaceId: "ws-vin", module: "inbox", smsText: "PropLane text: ...", emailSubject: "New text", emailText: "body", idempotencyKey: "inbound-alert:SM1" });
    expect(out).toMatchObject({ texted: 2, emailed: 1 });
    const calls = sendFromService.mock.calls.map((c) => c[1] as Record<string, unknown>);
    expect(calls.every((c) => c.purpose === SERVICE_ALERT_PHONE_SMS_PURPOSE)).toBe(true);
    expect(calls.find((c) => c.toPhone === CAPTAIN)).toMatchObject({ sendClass: "transactional", recipientUserId: null });
    expect(calls.find((c) => c.toPhone === "+12065550122")).toMatchObject({ sendClass: "automated", recipientUserId: "seat-v" });
    expect(ownWallet).not.toHaveBeenCalled();
    expect(sendEmail.mock.calls[0]![1]).toMatchObject({ recipientUserId: "seat-v", ownerUserId: "vin", workspaceId: "ws-vin" });
  });

  it("is idempotent per message: the same MessageSid yields the same per-recipient keys", async () => {
    roster = [{ userId: "vin", isOwner: true, role: null }];
    const input = { workspaceId: "ws-vin", smsText: "t", emailSubject: "s", emailText: "e", idempotencyKey: "inbound-alert:SM9" };
    await notifyServiceAlertTargets(seed(), input);
    await notifyServiceAlertTargets(seed(), input);
    const keys = sendFromService.mock.calls.map((c) => (c[1] as { dedupeKey: string }).dedupeKey);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
    const other = sendFromService.mock.calls.length;
    await notifyServiceAlertTargets(seed(), { ...input, idempotencyKey: "inbound-alert:SM10" });
    expect((sendFromService.mock.calls[other]![1] as { dedupeKey: string }).dedupeKey).not.toBe(keys[0]);
  });

  it("the spine's own leg (listed_only) does not text a seat holder or a listed number that IS a seat holder's: one text per event per person", async () => {
    const db = seed({ workspace_work_number_recipients: [
      { id: "r1", owner_user_id: "vin", label: "PropLane admin", phone: CAPTAIN, email: null, created_at: "2026-11-04T01:18:09Z" },
      { id: "r9", owner_user_id: "vin", label: "Ops", phone: "+12065550122", email: null, created_at: "2026-11-04T01:18:09Z" },
    ] });
    roster = [{ userId: "vin", isOwner: true, role: null }, { userId: "seat-v", isOwner: false, role: "viewer" }];
    await notifyServiceAlertTargets(db, { workspaceId: "ws-vin", scope: "listed_only", smsText: "t", emailSubject: "s", emailText: "e", idempotencyKey: "k" });
    expect(sendFromService.mock.calls.map((c) => (c[1] as { toPhone: string }).toPhone)).toEqual([CAPTAIN]);
  });

  it("seat_emails sends the seat holder's email and no text", async () => {
    roster = [{ userId: "vin", isOwner: true, role: null }, { userId: "seat-v", isOwner: false, role: "viewer" }];
    await notifyServiceAlertTargets(seed(), { workspaceId: "ws-vin", scope: "seat_emails", smsText: "", emailSubject: "s", emailText: "e", idempotencyKey: "k" });
    expect(sendFromService).not.toHaveBeenCalled();
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it("never silent: a credit refusal raises ONE Attention item for the service owner; quiet hours and STOP do not", async () => {
    roster = [{ userId: "vin", isOwner: true, role: null }];
    sendFromService.mockResolvedValue({ ok: false, reason: "comms_billing_allowance_exhausted" });
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await notifyServiceAlertTargets(seed(), { workspaceId: "ws-vin", smsText: "t", emailSubject: "s", emailText: "e", idempotencyKey: "k" });
    expect(notifyManager).toHaveBeenCalledTimes(1);
    expect(notifyManager.mock.calls[0]![1]).toMatchObject({ landlordId: "svc-owner", notify: { push: true, sms: false } });
    notifyManager.mockClear();
    sendFromService.mockResolvedValue({ ok: false, reason: "quiet_hours" });
    await notifyServiceAlertTargets(seed(), { workspaceId: "ws-vin", smsText: "t", emailSubject: "s", emailText: "e", idempotencyKey: "k2" });
    expect(notifyManager).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe("notifyWorkNumberRecipients (the notice spine's alert-phone leg)", () => {
  it("a managed workspace is paid by the platform even though its owner's wallet is empty", async () => {
    roster = [{ userId: "vin", isOwner: true, role: null }];
    const out = await notifyWorkNumberRecipients(seed(), { ownerUserId: "vin", workspaceId: "ws-vin", subject: "New booking", text: "5259 Room 2, Nov 6-9.", idempotencyKey: "evt-1" });
    expect(out.texted).toBe(1);
    expect(ownWallet).not.toHaveBeenCalled();
  });

  it("a self-serve workspace keeps its own wallet (the dispatcher's money gate) and a manager-recipient consent purpose", async () => {
    const out = await notifyWorkNumberRecipients(seed(), { ownerUserId: "self", workspaceId: "ws-self", subject: "New booking", text: "x", idempotencyKey: "evt-2" });
    expect(sendFromService).not.toHaveBeenCalled();
    expect(ownWallet).toHaveBeenCalledTimes(1);
    expect(ownWallet.mock.calls[0]![0]).toMatchObject({ managerUserId: "self", purpose: ALERT_PHONE_SMS_PURPOSE });
    expect(out.texted).toBe(1);
  });

  it("a self-serve refusal is logged with its reason, never swallowed", async () => {
    ownWallet.mockResolvedValueOnce({ ok: false, error: "comms_billing_allowance_exhausted" } as never);
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await notifyWorkNumberRecipients(seed(), { ownerUserId: "self", workspaceId: "ws-self", subject: "s", text: "t", idempotencyKey: "evt-3" });
    expect(spy).toHaveBeenCalledWith("extra recipient text refused", "comms_billing_allowance_exhausted");
    spy.mockRestore();
  });
});

describe("consent for alert-phone texts (the silent drop)", () => {
  it("both alert purposes are manager-recipient purposes, so the consent gate stops reading them as rental applications", () => {
    expect(isManagerRecipientSmsPurpose(ALERT_PHONE_SMS_PURPOSE)).toBe(true);
    expect(isManagerRecipientSmsPurpose(SERVICE_ALERT_PHONE_SMS_PURPOSE)).toBe(true);
    expect(isManagerRecipientSmsPurpose("manager_conversation")).toBe(false);
  });
});
