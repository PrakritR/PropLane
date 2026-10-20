import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ shared: vi.fn(), workNumber: vi.fn() }));
vi.mock("@/lib/one-number/send.server", () => ({ sendSharedLineMessage: mocks.shared }));
vi.mock("@/lib/proplane-sms-transport.server", () => ({ sendFromManagerWorkNumber: mocks.workNumber }));

import { deliveryForBasis, roleForLinkPurpose, sendWorkspacePhoneText } from "@/lib/one-number/link-text.server";
import { linksFakeDb, type Row } from "../helpers/links-fake-db";

const WS = "ws-a";
const input = { workspaceId: WS, phoneKey: "2065550142", body: "123456 is your PropLane code.", role: "prospect" as const, idempotencyKey: "phone-code:c1", basis: { kind: "code" as const } };
const world = (mode: string, pilot: string[] = []) =>
  linksFakeDb({
    portal_workspaces: [{ id: WS, owner_user_id: "owner-a" }],
    sms_runtime_config: [{ singleton: true, line_mode: mode, shared_number_e164: "+12065550100", shared_pilot_workspace_ids: pilot }] as Row[],
  }).db;

beforeEach(() => {
  mocks.shared.mockReset();
  mocks.workNumber.mockReset();
  mocks.workNumber.mockResolvedValue({ ok: true });
});

describe("sendWorkspacePhoneText", () => {
  it("per-workspace mode sends from the workspace's own work number, unlogged, never on the shared line", async () => {
    expect(await sendWorkspacePhoneText(world("per_workspace"), input)).toBe(true);
    expect(mocks.shared).not.toHaveBeenCalled();
    expect(mocks.workNumber).toHaveBeenCalledWith(expect.objectContaining({
      managerUserId: "owner-a", to: "+12065550142", text: input.body, sendClass: "control", purpose: "phone_link_code", skipLog: true, dedupeKey: "phone-code:c1",
    }));
  });

  it("shared mode goes through the shared-line sender with the workspace and role", async () => {
    mocks.shared.mockResolvedValue({ ok: true, messageSid: "SM1", segments: 1 });
    expect(await sendWorkspacePhoneText(world("shared"), input)).toBe(true);
    expect(mocks.shared.mock.calls[0]![1]).toMatchObject({
      workspaceId: WS, ownerUserId: "owner-a", toPhone: "+12065550142", role: "prospect", idempotencyKey: "phone-code:c1",
      delivery: { sendClass: "control", purpose: "phone_link_code", recipientUserId: null },
    });
    expect(mocks.workNumber).not.toHaveBeenCalled();
  });

  it("a real shared-line refusal is a refusal, not a fallback to another number", async () => {
    for (const reason of ["opted_out", "budget", "quiet_hours"] as const) {
      mocks.shared.mockResolvedValue({ ok: false, reason });
      expect(await sendWorkspacePhoneText(world("shared"), input)).toBe(false);
    }
    expect(mocks.workNumber).not.toHaveBeenCalled();
  });

  it("only while the shared sender is not live does a shared workspace fall back to its work number", async () => {
    mocks.shared.mockResolvedValue({ ok: false, reason: "not_shared_mode" });
    expect(await sendWorkspacePhoneText(world("shared"), input)).toBe(true);
    expect(mocks.workNumber).toHaveBeenCalledTimes(1);
  });

  it("a pilot list that leaves the workspace out uses the work number", async () => {
    expect(await sendWorkspacePhoneText(world("shared", ["other"]), input)).toBe(true);
    expect(mocks.shared).not.toHaveBeenCalled();
  });

  it("returns false for a bad phone, a missing workspace or a refused work-number send", async () => {
    expect(await sendWorkspacePhoneText(world("per_workspace"), { ...input, phoneKey: "12" })).toBe(false);
    expect(await sendWorkspacePhoneText(world("per_workspace"), { ...input, workspaceId: "nope" })).toBe(false);
    mocks.workNumber.mockResolvedValue({ ok: false, error: "recipient_opted_out" });
    expect(await sendWorkspacePhoneText(world("per_workspace"), input)).toBe(false);
  });
});

describe("roleForLinkPurpose", () => {
  it("bills a code as the role the person is acting in", () => {
    expect(roleForLinkPurpose("rent")).toBe("resident");
    expect(roleForLinkPurpose("move_in")).toBe("resident");
    expect(roleForLinkPurpose("lease")).toBe("applicant");
    expect(roleForLinkPurpose("job")).toBe("vendor");
    expect(roleForLinkPurpose("application")).toBe("prospect");
    expect(roleForLinkPurpose("tour")).toBe("prospect");
    expect(roleForLinkPurpose("gallery")).toBe("prospect");
  });
});

describe("the consent basis of every text this module sends (#4)", () => {
  it("a code the person just asked for is control class: no stored grant is needed, STOP still blocks at the dispatcher", () => {
    expect(deliveryForBasis({ kind: "code" }, "owner-a", "+12065550142")).toEqual({
      sendClass: "control", purpose: "phone_link_code", recipientUserId: null, recipientEmail: null, conversationKey: null, counterpartyRole: null, logToThread: false,
    });
  });

  it("an owner or manager notice uses the manager-recipient purposes and carries the recipient's account", async () => {
    const delivery = deliveryForBasis({ kind: "manager_notice", topic: "Owner Statement", recipientUserId: "owner-user" }, "owner-a", "+12065550142");
    expect(delivery).toMatchObject({ sendClass: "transactional", purpose: "manager_agent_notification_owner_statement", recipientUserId: "owner-user", counterpartyRole: "manager" });
    const { isManagerRecipientSmsPurpose } = await import("@/lib/sms/team-notice-consent.server");
    expect(isManagerRecipientSmsPurpose(delivery.purpose)).toBe(true);
  });

  it("a vendor notice rides the vendor thread's purpose and key", () => {
    const delivery = deliveryForBasis({ kind: "vendor_notice", recipientUserId: "vendor-1" }, "owner-a", "+12065550142");
    expect(delivery).toMatchObject({ sendClass: "transactional", purpose: "vendor_conversation", recipientUserId: "vendor-1", counterpartyRole: "vendor" });
    expect(delivery.conversationKey).toBeTruthy();
  });

  it("the work-number path hands the manager basis to the transport, unlogged", async () => {
    await sendWorkspacePhoneText(world("per_workspace"), { ...input, role: "manager", basis: { kind: "manager_notice", topic: "fee_policy", recipientUserId: "u-1" } });
    expect(mocks.workNumber).toHaveBeenCalledWith(expect.objectContaining({
      sendClass: "transactional", purpose: "manager_agent_notification_fee_policy", recipientUserId: "u-1", counterpartyRole: "manager", skipLog: true,
    }));
  });

  it("the shared-line path hands the same basis to the shared sender", async () => {
    mocks.shared.mockResolvedValue({ ok: true, messageSid: "SM1", segments: 1 });
    await sendWorkspacePhoneText(world("shared"), { ...input, role: "manager", basis: { kind: "manager_notice", topic: "repair_approval", recipientUserId: "u-2" } });
    expect(mocks.shared.mock.calls[0]![1].delivery).toMatchObject({ sendClass: "transactional", purpose: "manager_agent_notification_repair_approval", recipientUserId: "u-2" });
  });
});
