import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryDb } from "./support/memory-supabase";

const { sendFromWorkNumberMock, sendSmsMock, resolveSendNumberMock } = vi.hoisted(() => ({
  sendFromWorkNumberMock: vi.fn(async () => ({ ok: true as const })),
  sendSmsMock: vi.fn(async () => ({ sent: true as const, sid: "SM1" })),
  resolveSendNumberMock: vi.fn(async () => "+12065559000" as string | null),
}));

vi.mock("@/lib/proplane-sms-transport.server", () => ({
  sendFromManagerWorkNumber: sendFromWorkNumberMock,
}));
vi.mock("@/lib/twilio", () => ({
  sendSms: sendSmsMock,
}));
vi.mock("@/lib/sms/manager-number-provisioning.server", () => ({
  resolveActiveManagerSendNumber: resolveSendNumberMock,
}));

import {
  detectManagerSelfReply,
  forwardResidentInboundToManagerCell,
  handleManagerReplyInbound,
  maskedTexterLabel,
  resolveManagerActiveConversation,
  samePhone,
} from "@/lib/sms/manager-relay.server";

beforeEach(() => {
  sendFromWorkNumberMock.mockReset().mockResolvedValue({ ok: true });
  sendSmsMock.mockReset().mockResolvedValue({ sent: true, sid: "SM1" });
  resolveSendNumberMock.mockReset().mockResolvedValue("+12065559000");
});

describe("phone helpers", () => {
  it("samePhone matches across US formats and never on empties", () => {
    expect(samePhone("+12065550100", "(206) 555-0100")).toBe(true);
    expect(samePhone("12065550100", "2065550100")).toBe(true);
    expect(samePhone("+12065550100", "+12065550200")).toBe(false);
    expect(samePhone("", "2065550100")).toBe(false);
  });
  it("maskedTexterLabel never leaks the full number", () => {
    expect(maskedTexterLabel("+12065550100")).toBe("Texter ····0100");
  });
});

describe("detectManagerSelfReply — leg 2 detection", () => {
  const db = () =>
    createMemoryDb({
      profiles: [
        { id: "mgrA", phone: "+12065550100", phone_verified_at: "2026-01-01T00:00:00Z", sms_from_number: "+12065559000" },
        { id: "mgrB", phone: "+13105550200", phone_verified_at: "2026-01-01T00:00:00Z", sms_from_number: "+13105559000" },
        { id: "mgrC", phone: "+14155550300", phone_verified_at: null, sms_from_number: "+14155559000" },
      ],
    }) as never;

  it("recognises a manager texting their own work number from their verified cell", async () => {
    const res = await detectManagerSelfReply(db(), { managerUserId: "mgrA", fromPhone: "+12065550100", toPhone: "+12065559000" });
    expect(res).toMatchObject({ managerUserId: "mgrA", workNumber: "+12065559000" });
  });

  it("returns null when the sender is not the manager's own phone (cross-tenant safe)", async () => {
    // manager B's cell texting manager A's work number is NOT a self-reply for A.
    const res = await detectManagerSelfReply(db(), { managerUserId: "mgrA", fromPhone: "+13105550200", toPhone: "+12065559000" });
    expect(res).toBeNull();
  });

  it("returns null when the manager's phone is unverified", async () => {
    const res = await detectManagerSelfReply(db(), { managerUserId: "mgrC", fromPhone: "+14155550300", toPhone: "+14155559000" });
    expect(res).toBeNull();
  });
});

describe("resolveManagerActiveConversation — deterministic rule", () => {
  it("picks the most-recently-active resident thread and ignores prospects + other managers", async () => {
    const db = createMemoryDb({
      manager_sms_messages: [
        { manager_user_id: "mgrA", resident_phone: "2065551111", resident_user_id: "resOld", conversation_key: "k1", counterparty_role: "resident", created_at: "2026-07-20T10:00:00Z" },
        { manager_user_id: "mgrA", resident_phone: "2065552222", resident_user_id: "resNew", conversation_key: "k2", counterparty_role: "resident", created_at: "2026-07-24T10:00:00Z" },
        { manager_user_id: "mgrA", resident_phone: "2065553333", resident_user_id: null, conversation_key: "k3", counterparty_role: "prospect", created_at: "2026-07-25T10:00:00Z" },
        { manager_user_id: "mgrB", resident_phone: "3105554444", resident_user_id: "resOther", conversation_key: "k4", counterparty_role: "resident", created_at: "2026-07-26T10:00:00Z" },
      ],
    }) as never;
    const active = await resolveManagerActiveConversation(db, "mgrA");
    // Newest resident (k2), NOT the newer prospect (k3), NOT manager B's thread (k4).
    expect(active).toMatchObject({ residentPhone: "2065552222", residentUserId: "resNew" });
  });

  it("returns null when the manager has no resident conversation", async () => {
    const db = createMemoryDb({ manager_sms_messages: [] }) as never;
    expect(await resolveManagerActiveConversation(db, "mgrA")).toBeNull();
  });
});

describe("handleManagerReplyInbound — leg 2 delivery", () => {
  it("delivers the reply to the active resident from the work number", async () => {
    sendFromWorkNumberMock.mockClear();
    const db = createMemoryDb({
      manager_sms_messages: [
        { manager_user_id: "mgrA", resident_phone: "2065552222", resident_user_id: "resNew", conversation_key: "k2", counterparty_role: "resident", created_at: "2026-07-24T10:00:00Z" },
      ],
    }) as never;
    const res = await handleManagerReplyInbound(db, { managerUserId: "mgrA", workNumber: "+12065559000", body: "on my way", messageSid: "SM11111111111111111111111111111111" });
    expect(res).toMatchObject({ ok: true, residentPhone: "2065552222" });
    expect(sendFromWorkNumberMock).toHaveBeenCalledWith(
      expect.objectContaining({ managerUserId: "mgrA", to: "2065552222", text: "on my way", counterpartyRole: "resident", dedupeKey: "manager_reply_SM11111111111111111111111111111111" }),
    );
  });

  it("reports no_active_conversation when there is nothing to reply to", async () => {
    const db = createMemoryDb({ manager_sms_messages: [] }) as never;
    const res = await handleManagerReplyInbound(db, { managerUserId: "mgrA", workNumber: "+12065559000", body: "hi", messageSid: "SM22222222222222222222222222222222" });
    expect(res).toMatchObject({ ok: false, error: "no_active_conversation" });
  });

  it("is registration-gated: returns registration_pending and does NOT send when the number can't send yet", async () => {
    resolveSendNumberMock.mockResolvedValue(null); // registration not approved
    const db = createMemoryDb({
      manager_sms_messages: [
        { manager_user_id: "mgrA", resident_phone: "2065552222", resident_user_id: "resNew", conversation_key: "k2", counterparty_role: "resident", created_at: "2026-07-24T10:00:00Z" },
      ],
    }) as never;
    const res = await handleManagerReplyInbound(db, { managerUserId: "mgrA", workNumber: "+12065559000", body: "hi", messageSid: "SM33333333333333333333333333333333" });
    expect(res).toMatchObject({ ok: false, error: "registration_pending" });
    expect(sendFromWorkNumberMock).not.toHaveBeenCalled();
  });
});

describe("forwardResidentInboundToManagerCell — managed pilot", () => {
  it("keeps manager-cell forwarding disabled until it has its own consent-bound reply design", async () => {
    const db = createMemoryDb({
      profiles: [
        { id: "mgrA", phone: "+12065550100", phone_verified_at: "2026-01-01T00:00:00Z" },
        { id: "resNew", full_name: "Jamie Rivera" },
      ],
      // resident_phone stored E.164, as logManagerSmsMessage writes it.
      manager_sms_messages: [
        { manager_user_id: "mgrA", resident_phone: "+12065552222", resident_user_id: "resNew" },
      ],
    }) as never;
    const ok = await forwardResidentInboundToManagerCell(db, {
      managerUserId: "mgrA",
      workNumber: "+12065559000",
      fromPhone: "+12065552222",
      body: "leak in unit 4",
    });
    expect(ok).toBe(false);
    expect(sendSmsMock).not.toHaveBeenCalled();
  });

  it("no-ops when the manager has no verified cell", async () => {
    const db = createMemoryDb({ profiles: [{ id: "mgrA", phone: "", phone_verified_at: null }] }) as never;
    const ok = await forwardResidentInboundToManagerCell(db, { managerUserId: "mgrA", workNumber: "+12065559000", fromPhone: "+12065552222", body: "hi" });
    expect(ok).toBe(false);
  });

  it("is registration-gated: no forward when the number can't send yet", async () => {
    resolveSendNumberMock.mockResolvedValue(null); // registration not approved
    const db = createMemoryDb({
      profiles: [{ id: "mgrA", phone: "+12065550100", phone_verified_at: "2026-01-01T00:00:00Z" }],
    }) as never;
    const ok = await forwardResidentInboundToManagerCell(db, { managerUserId: "mgrA", workNumber: "+12065559000", fromPhone: "+12065552222", body: "hi" });
    expect(ok).toBe(false);
    expect(sendSmsMock).not.toHaveBeenCalled();
  });
});
