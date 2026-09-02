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
  maskedTexterLabel,
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

// The blind Leg 2 relay (resolveManagerActiveConversation / handleManagerReplyInbound)
// is gone: a manager texting their work number now reaches the manager agent, and
// contacting a resident is a named proposal they confirm. Coverage moved to
// tests/unit/manager-sms-agent.test.ts and tests/unit/twilio-inbound-retry.test.ts.

describe("forwardResidentInboundToManagerCell — leg 1", () => {
  // Consent scope keys include the messaging service, so pin it rather than
  // inheriting whatever the running machine happens to export.
  beforeEach(() => {
    vi.stubEnv("TWILIO_MESSAGING_SERVICE_SID", "MGtest");
  });

  const seededDb = () =>
    createMemoryDb({
      profiles: [
        { id: "mgrA", phone: "+12065550100", phone_verified_at: "2026-01-01T00:00:00Z" },
        { id: "resNew", full_name: "Jamie Rivera" },
      ],
      // resident_phone stored E.164, as logManagerSmsMessage writes it.
      manager_sms_messages: [
        { manager_user_id: "mgrA", resident_phone: "+12065552222", resident_user_id: "resNew" },
      ],
    }) as never;

  it("mirrors the resident's text to the manager's verified cell, labelled and deduped", async () => {
    const db = seededDb();
    const ok = await forwardResidentInboundToManagerCell(db, {
      managerUserId: "mgrA",
      workNumber: "+12065559000",
      fromPhone: "+12065552222",
      body: "leak in unit 4",
      messageSid: "SMinbound1",
      counterpartyRole: "resident",
    });

    expect(ok).toBe(true);
    expect(sendFromWorkNumberMock).toHaveBeenCalledWith(
      expect.objectContaining({
        managerUserId: "mgrA",
        to: "+12065550100",
        fromNumber: "+12065559000",
        // Retried webhooks must not text the manager the same message twice.
        dedupeKey: "manager_forward_SMinbound1",
        // The resident's own words are already in their thread; a second copy
        // would render as an outbound they never received.
        skipLog: true,
      }),
    );
    const [[sent]] = sendFromWorkNumberMock.mock.calls as unknown as [[{ text: string }]];
    expect(sent.text).toContain("Jamie Rivera");
    expect(sent.text).toContain("leak in unit 4");
    // Never hand the manager a number we labelled around.
    expect(sent.text).not.toContain("+12065552222");
  });

  it("only invites a texted-back reply when the mirror is a resident's", async () => {
    // Leg 2 routes a manager's reply to their newest RESIDENT thread and skips
    // prospect threads, so telling them to reply to a prospect's mirror would
    // deliver that reply to an unrelated resident.
    const db = seededDb();
    await forwardResidentInboundToManagerCell(db, {
      managerUserId: "mgrA",
      workNumber: "+12065559000",
      fromPhone: "+12065552222",
      body: "is the unit still available?",
      counterpartyRole: "prospect",
    });
    const [[prospect]] = sendFromWorkNumberMock.mock.calls as unknown as [[{ text: string }]];
    expect(prospect.text).toContain("Reply in PropLane");
    expect(prospect.text).not.toContain("Reply to this text");

    sendFromWorkNumberMock.mockClear();
    await forwardResidentInboundToManagerCell(seededDb(), {
      managerUserId: "mgrA",
      workNumber: "+12065559000",
      fromPhone: "+12065552222",
      body: "leak in unit 4",
      counterpartyRole: "resident",
    });
    const [[resident]] = sendFromWorkNumberMock.mock.calls as unknown as [[{ text: string }]];
    expect(resident.text).toContain("Reply to this text");
  });

  it("records the manager's own verification as the consent evidence for the mirror scope", async () => {
    const db = seededDb();
    await forwardResidentInboundToManagerCell(db, {
      managerUserId: "mgrA",
      workNumber: "+12065559000",
      fromPhone: "+12065552222",
      body: "leak in unit 4",
    });
    const events = (db as unknown as { __tables: Record<string, Record<string, unknown>[]> })
      .__tables.sms_consent_events;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      manager_user_id: "mgrA",
      purpose: "manager_inbound_forward",
      send_class: "transactional",
      event_type: "granted",
      source: "manager_phone_verification",
    });
  });

  it("honours a revoke on the mirror scope without re-granting it", async () => {
    const db = createMemoryDb({
      profiles: [{ id: "mgrA", phone: "+12065550100", phone_verified_at: "2026-01-01T00:00:00Z" }],
      sms_consent_events: [
        {
          recipient_phone_key: "2065550100",
          manager_user_id: "mgrA",
          purpose: "manager_inbound_forward",
          send_class: "transactional",
          conversation_key: "mgrA:manager:mgrA",
          messaging_service_sid: "MGtest",
          event_type: "revoked",
          occurred_at: "2026-02-01T00:00:00Z",
        },
      ],
    }) as never;
    const ok = await forwardResidentInboundToManagerCell(db, {
      managerUserId: "mgrA",
      workNumber: "+12065559000",
      fromPhone: "+12065552222",
      body: "hi",
    });
    expect(ok).toBe(false);
    expect(sendFromWorkNumberMock).not.toHaveBeenCalled();
  });

  it("respects the manager's own opt-out preference", async () => {
    const db = createMemoryDb({
      profiles: [
        {
          id: "mgrA",
          phone: "+12065550100",
          phone_verified_at: "2026-01-01T00:00:00Z",
          sms_forward_inbound: false,
        },
      ],
    }) as never;
    const ok = await forwardResidentInboundToManagerCell(db, { managerUserId: "mgrA", workNumber: "+12065559000", fromPhone: "+12065552222", body: "hi" });
    expect(ok).toBe(false);
    expect(sendFromWorkNumberMock).not.toHaveBeenCalled();
  });

  it("never mirrors the manager's own text back to them (that is leg 2)", async () => {
    const db = createMemoryDb({
      profiles: [{ id: "mgrA", phone: "+12065550100", phone_verified_at: "2026-01-01T00:00:00Z" }],
    }) as never;
    const ok = await forwardResidentInboundToManagerCell(db, { managerUserId: "mgrA", workNumber: "+12065559000", fromPhone: "(206) 555-0100", body: "hi" });
    expect(ok).toBe(false);
    expect(sendFromWorkNumberMock).not.toHaveBeenCalled();
  });

  it("no-ops when the manager has no verified cell", async () => {
    const db = createMemoryDb({ profiles: [{ id: "mgrA", phone: "", phone_verified_at: null }] }) as never;
    const ok = await forwardResidentInboundToManagerCell(db, { managerUserId: "mgrA", workNumber: "+12065559000", fromPhone: "+12065552222", body: "hi" });
    expect(ok).toBe(false);
    expect(sendFromWorkNumberMock).not.toHaveBeenCalled();
  });

  it("is registration-gated: no forward when the number can't send yet", async () => {
    resolveSendNumberMock.mockResolvedValue(null); // registration not approved
    const db = createMemoryDb({
      profiles: [{ id: "mgrA", phone: "+12065550100", phone_verified_at: "2026-01-01T00:00:00Z" }],
    }) as never;
    const ok = await forwardResidentInboundToManagerCell(db, { managerUserId: "mgrA", workNumber: "+12065559000", fromPhone: "+12065552222", body: "hi" });
    expect(ok).toBe(false);
    expect(sendFromWorkNumberMock).not.toHaveBeenCalled();
  });
});
