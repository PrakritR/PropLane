import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryDb } from "./support/memory-supabase";
import { createConsentLedger } from "./support/consent-ledger-fake";

/**
 * Vendor texting, inbound side (Oct 6): a vendor on the manager's list - or a
 * linked account that VERIFIED the number - texting the work number lands in the
 * manager's vendor thread and unlocks the reply; a number the manager texted in
 * the last 90 days is not a Potential resident; the manager's own conversation
 * (7 days) wins over the job assistant.
 */
const hoisted = vi.hoisted(() => ({
  ledger: null as null | ReturnType<typeof import("./support/consent-ledger-fake").createConsentLedger>,
}));
vi.mock("@/lib/sms-consent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/sms-consent")>();
  return {
    ...actual,
    normalizeConsentPhone: (phone: string) => hoisted.ledger!.module.normalizeConsentPhone(phone),
    readSmsSuppressionState: (_db: unknown, phone: string) => hoisted.ledger!.module.readSmsSuppressionState(phone),
    readScopedSmsConsentState: (_db: unknown, ...a: Parameters<ReturnType<typeof createConsentLedger>["module"]["readScopedSmsConsentState"]>) =>
      hoisted.ledger!.module.readScopedSmsConsentState(...a),
    recordScopedSmsConsent: (_db: unknown, ...a: Parameters<ReturnType<typeof createConsentLedger>["module"]["recordScopedSmsConsent"]>) =>
      hoisted.ledger!.module.recordScopedSmsConsent(...a),
  };
});

import {
  MANAGER_CONVERSATION_WINS_DAYS,
  managerTextedPhoneWithin,
  routeUnrecognizedInboundText,
} from "@/lib/sms/inbound-text-routing.server";
import { handleVendorSessionInbound } from "@/lib/sms/vendor-inbound-session.server";
import { readVendorTextConsent, recordVendorInboundReplyConsent } from "@/lib/sms/vendor-conversation-consent.server";

const OWNER = "mgr-seattle";
const PHONE = "+14255550199";
const NOW = new Date("2026-10-06T18:00:00Z");
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 86_400_000).toISOString();
const TEXT = { managerUserId: OWNER, workspaceId: "ws-seattle", fromPhone: "(425) 555-0199" };

function database(seed: Record<string, Record<string, unknown>[]> = {}) {
  const db = createMemoryDb({
    manager_vendor_records: [],
    manager_application_records: [],
    profiles: [],
    sms_outbox: [],
    ...seed,
  });
  hoisted.ledger = createConsentLedger(db);
  return db;
}
const outbound = (over: Record<string, unknown> = {}) => ({
  manager_user_id: OWNER,
  recipient_phone: PHONE,
  dedupe_key: "manager:send-1",
  status: "delivered",
  counterparty_role: "vendor",
  recipient_user_id: null,
  created_at: daysAgo(3),
  ...over,
});
const roster = (over: Record<string, unknown> = {}, rowOver: Record<string, unknown> = {}) => ({
  id: "ven-1",
  manager_user_id: OWNER,
  vendor_user_id: null,
  row_data: { id: "ven-1", name: "Mike's Plumbing", phone: "(425) 555-0199", email: "", active: true, ...rowOver },
  ...over,
});

beforeEach(() => {
  vi.stubEnv("TWILIO_MESSAGING_SERVICE_SID", "MGtest");
});

describe("who a vendor text is from", () => {
  it("a roster vendor's reply lands on that vendor, not a Potential resident", async () => {
    const db = database({ manager_vendor_records: [roster()] });
    const result = await routeUnrecognizedInboundText(db as never, { ...TEXT, body: "Yes I can come Thursday 10am" });

    expect(result).toMatchObject({ kind: "vendor", vendorId: "ven-1", name: "Mike's Plumbing", created: false });
    expect(db.__tables.manager_application_records).toHaveLength(0);
  });

  it("a linked account's VERIFIED phone identifies the vendor even when the roster row lists another number", async () => {
    const db = database({
      manager_vendor_records: [roster({ vendor_user_id: "vendor-user-1" }, { phone: "(206) 555-0000" })],
      profiles: [{ id: "vendor-user-1", phone: "+14255550199", phone_verified_at: "2026-10-01T00:00:00Z" }],
    });
    const result = await routeUnrecognizedInboundText(db as never, { ...TEXT, body: "On my way" });

    expect(result).toMatchObject({ kind: "vendor", vendorId: "ven-1", vendorUserId: "vendor-user-1" });
  });

  it("a typed (unverified) profile phone identifies nobody", async () => {
    const db = database({
      manager_vendor_records: [roster({ vendor_user_id: "vendor-user-1" }, { phone: "(206) 555-0000" })],
      profiles: [{ id: "vendor-user-1", phone: "+14255550199", phone_verified_at: null }],
    });
    const result = await routeUnrecognizedInboundText(db as never, { ...TEXT, body: "Is the room still available?" });

    expect(result.kind).toBe("potential");
  });

  it("a number two accounts verified identifies neither", async () => {
    const db = database({
      manager_vendor_records: [roster({ vendor_user_id: "vendor-user-1" }, { phone: "(206) 555-0000" })],
      profiles: [
        { id: "vendor-user-1", phone: "+14255550199", phone_verified_at: "2026-10-01T00:00:00Z" },
        { id: "someone-else", phone: "+14255550199", phone_verified_at: "2026-10-02T00:00:00Z" },
      ],
    });
    const result = await routeUnrecognizedInboundText(db as never, { ...TEXT, body: "Is the room still available?" });

    expect(result.kind).toBe("potential");
  });
});

describe("an unknown number the manager texted", () => {
  it("routes to the vendor thread when the manager texted it as a vendor in the last 90 days", async () => {
    const db = database({ sms_outbox: [outbound({ created_at: daysAgo(40), recipient_user_id: "vendor-user-9" })] });
    const result = await routeUnrecognizedInboundText(db as never, { ...TEXT, body: "Is the room still available?" });

    expect(result).toMatchObject({ kind: "vendor", vendorId: null, vendorUserId: "vendor-user-9", created: false });
    expect(db.__tables.manager_application_records).toHaveLength(0);
  });

  it("is a Potential resident again once the text is older than 90 days", async () => {
    const db = database({ sms_outbox: [outbound({ created_at: daysAgo(120) })] });
    const result = await routeUnrecognizedInboundText(db as never, { ...TEXT, body: "Is the room still available?" });
    expect(result.kind).toBe("potential");
  });

  it("does not count a text the manager sent to a prospect, or one the job assistant sent", async () => {
    const prospect = database({ sms_outbox: [outbound({ counterparty_role: "prospect" })] });
    expect((await routeUnrecognizedInboundText(prospect as never, { ...TEXT, body: "Hi" })).kind).toBe("potential");

    const assistant = database({ sms_outbox: [outbound({ dedupe_key: "vendor_opening:session-1" })] });
    expect((await routeUnrecognizedInboundText(assistant as never, { ...TEXT, body: "Hi" })).kind).toBe("potential");
  });

  it("does not count another manager's text to the same number", async () => {
    const db = database({ sms_outbox: [outbound({ manager_user_id: "mgr-other" })] });
    expect((await routeUnrecognizedInboundText(db as never, { ...TEXT, body: "Hi" })).kind).toBe("potential");
  });
});

describe("the vendor's reply unlocks the manager's reply", () => {
  const key = `${OWNER}:vendor:${PHONE}`;

  it("records a vendor_conversation grant for the exact thread, with the inbound as evidence", async () => {
    const db = database();
    const result = await recordVendorInboundReplyConsent(db as never, {
      managerUserId: OWNER, vendorUserId: null, phone: PHONE, messageSid: "SMin1",
    });

    expect(result).toBe("allowed");
    expect(hoisted.ledger!.events).toEqual([
      expect.objectContaining({
        managerUserId: OWNER, purpose: "vendor_conversation", conversationKey: key, eventType: "granted",
        source: "recipient_initiated_inbound", evidence: { messageSid: "SMin1", role: "vendor" },
      }),
    ]);
    const state = await readVendorTextConsent(db as never, { managerUserId: OWNER, vendorUserId: null, phone: PHONE });
    expect(state).toMatchObject({ ok: true, state: "granted", grantedUnder: key });
  });

  it("is idempotent for a repeated text", async () => {
    const db = database();
    await recordVendorInboundReplyConsent(db as never, { managerUserId: OWNER, vendorUserId: null, phone: PHONE, messageSid: "SMin1" });
    await recordVendorInboundReplyConsent(db as never, { managerUserId: OWNER, vendorUserId: null, phone: PHONE, messageSid: "SMin2" });
    expect(hoisted.ledger!.events).toHaveLength(1);
  });

  it("never overrides STOP or a revoke", async () => {
    const stopped = database();
    hoisted.ledger!.stop(PHONE);
    expect(await recordVendorInboundReplyConsent(stopped as never, { managerUserId: OWNER, vendorUserId: null, phone: PHONE, messageSid: "SMin1" })).toBe("suppressed");
    expect(hoisted.ledger!.events).toHaveLength(0);

    const revoked = database();
    await hoisted.ledger!.module.recordScopedSmsConsent(PHONE, {
      managerUserId: OWNER, purpose: "vendor_conversation", sendClass: "transactional", conversationKey: key,
      messagingServiceSid: "MGtest", eventType: "revoked", source: "twilio_stop",
    });
    expect(await recordVendorInboundReplyConsent(revoked as never, { managerUserId: OWNER, vendorUserId: null, phone: PHONE, messageSid: "SMin1" })).toBe("suppressed");
    expect(hoisted.ledger!.events).toHaveLength(1);
  });

  it("without messaging configured it records nothing and does not throw", async () => {
    vi.stubEnv("TWILIO_MESSAGING_SERVICE_SID", "");
    const db = database();
    expect(await recordVendorInboundReplyConsent(db as never, { managerUserId: OWNER, vendorUserId: null, phone: PHONE, messageSid: "SMin1" })).toBe("unavailable");
    expect(hoisted.ledger!.events).toHaveLength(0);
  });
});

describe("the manager's conversation wins over the job assistant (7 days)", () => {
  const session = { vendor_user_id: "vendor-user-1" };
  const run = (db: ReturnType<typeof database>, runTurn = vi.fn(async () => "reply")) =>
    handleVendorSessionInbound(db as never, {
      managerUserId: OWNER, phoneE164: PHONE, messageSid: "SMjob1", body: "On my way",
      vendor: { kind: "session", session, reference: null }, runTurn: runTurn as never, now: NOW,
    }).then((out) => ({ out, runTurn }));

  it("suppresses the job assistant when the manager texted this vendor within 7 days, and unlocks the reply", async () => {
    const db = database({ sms_outbox: [outbound({ created_at: daysAgo(MANAGER_CONVERSATION_WINS_DAYS - 1) })] });
    const { out, runTurn } = await run(db);

    expect(out.route).toBe("manager_thread");
    expect(runTurn).not.toHaveBeenCalled();
    expect(hoisted.ledger!.events).toHaveLength(1);
    expect(hoisted.ledger!.events[0]).toMatchObject({ purpose: "vendor_conversation", source: "recipient_initiated_inbound" });
  });

  it("the job assistant answers as today when the manager's last text is older than 7 days", async () => {
    const db = database({ sms_outbox: [outbound({ created_at: daysAgo(MANAGER_CONVERSATION_WINS_DAYS + 1) })] });
    const { out, runTurn } = await run(db);

    expect(out.route).toBe("job_assistant");
    expect(runTurn).toHaveBeenCalledOnce();
    expect(runTurn.mock.calls[0]).toEqual(expect.arrayContaining(["On my way", "sms"]));
  });

  it("the job assistant answers when the manager never texted this vendor", async () => {
    const { out, runTurn } = await run(database());
    expect(out.route).toBe("job_assistant");
    expect(runTurn).toHaveBeenCalledOnce();
  });

  it("the assistant's own texts never count as the manager's conversation", async () => {
    const db = database({ sms_outbox: [outbound({ dedupe_key: "vendor_opening:session-1", created_at: daysAgo(1) })] });
    const { out } = await run(db);
    expect(out.route).toBe("job_assistant");
  });

  it("a text that never went out (blocked / failed) does not count", async () => {
    const db = database({ sms_outbox: [outbound({ status: "blocked", created_at: daysAgo(1) })] });
    expect((await run(db)).out.route).toBe("job_assistant");
  });

  it("managerTextedPhoneWithin reports the recipient account of the latest manager text", async () => {
    const db = database({ sms_outbox: [outbound({ recipient_user_id: "vendor-user-1", created_at: daysAgo(2) })] });
    expect(await managerTextedPhoneWithin(db as never, { managerUserId: OWNER, phoneE164: PHONE, days: 7, now: NOW })).toEqual({
      texted: true,
      recipientUserId: "vendor-user-1",
    });
  });
});
