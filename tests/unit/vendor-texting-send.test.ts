import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryDb } from "./support/memory-supabase";
import { createConsentLedger } from "./support/consent-ledger-fake";

/**
 * Vendor texting (Oct 6): a manager texts a roster vendor from the workspace work
 * number. The first text needs the manager's attestation, which is stored as
 * `vendor_conversation` consent evidence and puts the sender line + STOP footer on
 * the message; STOP always wins; the destination is the roster row's own phone.
 */
const hoisted = vi.hoisted(() => ({
  enqueue: vi.fn(),
  dispatch: vi.fn(),
  scope: vi.fn(),
  sendLine: vi.fn(),
  ledger: null as null | ReturnType<typeof import("./support/consent-ledger-fake").createConsentLedger>,
}));
vi.mock("@/lib/manager-sms-messages.server", () => ({
  fetchManagerSmsConversations: vi.fn(async () => ({ residents: [] })),
  resolveSmsScopeManagerIds: hoisted.scope,
}));
vi.mock("@/lib/sms/owner-sms-dispatcher.server", () => ({
  enqueueOwnerSms: hoisted.enqueue,
  dispatchOwnerSmsOutbox: hoisted.dispatch,
}));
vi.mock("@/lib/sms/manager-workspace-role.server", () => ({ resolveConversationSendLine: hoisted.sendLine }));
vi.mock("@/lib/analytics/posthog", () => ({ track: vi.fn() }));
vi.mock("@/lib/sms-consent", () => ({
  normalizeConsentPhone: (phone: string) => hoisted.ledger!.module.normalizeConsentPhone(phone),
  readSmsSuppressionState: (_db: unknown, phone: string) => hoisted.ledger!.module.readSmsSuppressionState(phone),
  readScopedSmsConsentState: (_db: unknown, ...a: Parameters<ReturnType<typeof createConsentLedger>["module"]["readScopedSmsConsentState"]>) =>
    hoisted.ledger!.module.readScopedSmsConsentState(...a),
  recordScopedSmsConsent: (_db: unknown, ...a: Parameters<ReturnType<typeof createConsentLedger>["module"]["recordScopedSmsConsent"]>) =>
    hoisted.ledger!.module.recordScopedSmsConsent(...a),
}));

import { readRosterVendorTextStatus, sendManagerConversationSms } from "@/lib/manager-sms-send.server";

const OWNER = "mgr-1";
const ACTOR = "mgr-1";
const VENDOR_ROW = "vendor-sms-aaaa";
const PHONE = "+14255550199";
const LINE_FOOTER = "— Sam at Alder Property Co via PropLane. Reply STOP to opt out.";

function seed(overrides: { phone?: string; vendorUserId?: string | null; active?: boolean } = {}) {
  const db = createMemoryDb({
    manager_vendor_records: [
      {
        id: VENDOR_ROW,
        manager_user_id: OWNER,
        vendor_user_id: overrides.vendorUserId ?? null,
        row_data: { id: VENDOR_ROW, name: "Mike's Plumbing", phone: overrides.phone ?? "(425) 555-0199", email: "", active: overrides.active ?? true },
      },
    ],
    profiles: [{ id: ACTOR, full_name: "Sam Rivera" }],
    manager_sms_numbers: [{ id: "line-1", workspace_id: "ws-1", phone_number: "+12065550142" }],
    portal_workspaces: [{ id: "ws-1", name: "Alder Property Co", owner_user_id: OWNER }],
    sms_outbox: [],
    sms_projection_conversations: [],
    inbound_sms_log: [],
  });
  hoisted.ledger = createConsentLedger(db);
  return db;
}

const send = (db: ReturnType<typeof seed>, extra: Record<string, unknown> = {}) =>
  sendManagerConversationSms(db as never, {
    actorUserId: ACTOR,
    toPhone: PHONE,
    text: "Hi Mike, can you look at a leak under the kitchen sink at 1420 Alder St this week?",
    vendorRecordId: VENDOR_ROW,
    idempotencyKey: "vendor_text_test_0001",
    ...extra,
  });

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("TWILIO_MESSAGING_SERVICE_SID", "MGtest");
  hoisted.scope.mockResolvedValue([OWNER]);
  hoisted.sendLine.mockResolvedValue({ ok: true, numberId: "line-1", phoneNumber: "+12065550142", via: "only" });
  hoisted.enqueue.mockResolvedValue({ ok: true, outboxId: "outbox-1", status: "queued" });
  hoisted.dispatch.mockResolvedValue({ submitted: 1, unknown: 0 });
});

describe("a cold, attested text to a roster vendor", () => {
  it("sends from the work number to the vendor's own saved phone, with the sender line and STOP footer", async () => {
    const db = seed();
    const result = await send(db, { attestVendorRelationship: true });

    expect(result.status).toBe(200);
    expect(hoisted.enqueue).toHaveBeenCalledOnce();
    const call = hoisted.enqueue.mock.calls[0]![0];
    expect(call).toMatchObject({
      managerUserId: OWNER,
      selectedWorkLineId: "line-1",
      recipientPhone: PHONE,
      purpose: "vendor_conversation",
      sendClass: "transactional",
      counterpartyRole: "vendor",
      conversationKey: `${OWNER}:vendor:${PHONE}`,
    });
    expect(call.body).toMatch(/this week\?/);
    expect(call.body.endsWith(LINE_FOOTER)).toBe(true);
  });

  it("records the vendor_conversation consent with the attestation as evidence", async () => {
    const db = seed();
    await send(db, { attestVendorRelationship: true });

    const [event, ...rest] = hoisted.ledger!.events;
    expect(rest).toHaveLength(0);
    expect(event).toMatchObject({
      managerUserId: OWNER,
      purpose: "vendor_conversation",
      eventType: "granted",
      source: "manager_attested_vendor_relationship",
      conversationKey: `${OWNER}:vendor:${PHONE}`,
      wordingVersion: "vendor-text-attestation-v1",
    });
    expect(event!.evidence).toMatchObject({
      attestation: "i_work_with_this_vendor",
      attestedBy: ACTOR,
      vendorRecordId: VENDOR_ROW,
      senderLine: LINE_FOOTER,
      stopFooter: true,
    });
  });

  it("is refused without the attestation when the vendor has no consent yet", async () => {
    const db = seed();
    const result = await send(db);

    expect(result.status).toBe(409);
    expect(result.body).toMatchObject({ code: "vendor_attestation_required" });
    expect(hoisted.enqueue).not.toHaveBeenCalled();
    expect(hoisted.ledger!.events).toHaveLength(0);
  });

  it("only the first text carries the footer: once a text was accepted the next one is the message alone", async () => {
    const db = seed();
    await send(db, { attestVendorRelationship: true });
    // The first text was accepted for delivery.
    db.__tables.sms_outbox!.push({
      manager_user_id: OWNER, recipient_phone: PHONE, purpose: "vendor_conversation", dedupe_key: "manager:vendor_text_test_0001", status: "submitted",
    });
    hoisted.enqueue.mockClear();

    const second = await send(db, { text: "Riley in Room 1 will be there.", idempotencyKey: "vendor_text_test_0002" });

    expect(second.status).toBe(200);
    expect(hoisted.enqueue.mock.calls[0]![0].body).toBe("Riley in Room 1 will be there.");
    expect(hoisted.ledger!.events).toHaveLength(1);
  });

  it("an attestation whose first text never left (no credit) still puts the footer on the retry", async () => {
    const db = seed();
    hoisted.enqueue.mockResolvedValueOnce({ ok: false, error: "comms_billing_insufficient_credit" });
    const first = await send(db, { attestVendorRelationship: true });
    expect(first.status).toBe(503);

    hoisted.enqueue.mockClear();
    hoisted.enqueue.mockResolvedValue({ ok: true, outboxId: "outbox-2", status: "queued" });
    const retry = await send(db, { idempotencyKey: "vendor_text_test_0003" });

    expect(retry.status).toBe(200);
    expect(hoisted.enqueue.mock.calls[0]![0].body.endsWith(LINE_FOOTER)).toBe(true);
    expect(hoisted.ledger!.events).toHaveLength(1);
  });
});

describe("STOP and consent state", () => {
  it("STOP blocks the send and the attestation never overrides it", async () => {
    const db = seed();
    hoisted.ledger!.stop(PHONE);
    const result = await send(db, { attestVendorRelationship: true });

    expect(result.status).toBe(409);
    expect(result.body).toMatchObject({ error: "That number has opted out of texts." });
    expect(hoisted.enqueue).not.toHaveBeenCalled();
    expect(hoisted.ledger!.events).toHaveLength(0);
  });

  it("START re-allows: a vendor who texted STOP then START can be texted again", async () => {
    const db = seed();
    hoisted.ledger!.stop(PHONE);
    hoisted.ledger!.start(PHONE);
    const result = await send(db, { attestVendorRelationship: true });
    expect(result.status).toBe(200);
  });

  it("a revoked scope cannot be re-attested", async () => {
    const db = seed();
    await hoisted.ledger!.module.recordScopedSmsConsent(PHONE, {
      managerUserId: OWNER, purpose: "vendor_conversation", sendClass: "transactional",
      conversationKey: `${OWNER}:vendor:${PHONE}`, messagingServiceSid: "MGtest", eventType: "revoked", source: "twilio_stop",
    });
    const result = await send(db, { attestVendorRelationship: true });

    expect(result.status).toBe(409);
    expect(hoisted.enqueue).not.toHaveBeenCalled();
  });

  it("a vendor who texted the work number first (inbound consent) needs no attestation and gets no footer", async () => {
    const db = seed();
    await hoisted.ledger!.module.recordScopedSmsConsent(PHONE, {
      managerUserId: OWNER, purpose: "vendor_conversation", sendClass: "transactional",
      conversationKey: `${OWNER}:vendor:${PHONE}`, messagingServiceSid: "MGtest", eventType: "granted", source: "recipient_initiated_inbound",
    });
    const result = await send(db);

    expect(result.status).toBe(200);
    expect(hoisted.enqueue.mock.calls[0]![0].body).toBe(
      "Hi Mike, can you look at a leak under the kitchen sink at 1420 Alder St this week?",
    );
  });

  it("a grant under the account's key still counts after the vendor's account links, and is carried to the new key", async () => {
    const db = seed({ vendorUserId: "vendor-user-1" });
    await hoisted.ledger!.module.recordScopedSmsConsent(PHONE, {
      managerUserId: OWNER, purpose: "vendor_conversation", sendClass: "transactional",
      conversationKey: `${OWNER}:vendor:${PHONE}`, messagingServiceSid: "MGtest", eventType: "granted", source: "recipient_initiated_inbound",
    });
    const result = await send(db);

    expect(result.status).toBe(200);
    expect(hoisted.enqueue.mock.calls[0]![0]).toMatchObject({
      conversationKey: `${OWNER}:vendor:vendor-user-1`,
      recipientUserId: "vendor-user-1",
    });
    expect(hoisted.ledger!.events.at(-1)).toMatchObject({
      conversationKey: `${OWNER}:vendor:vendor-user-1`,
      source: "carried_from_vendor_key",
    });
  });
});

describe("the destination is the roster row's own phone", () => {
  it("refuses a browser phone that is not the vendor's saved phone", async () => {
    const db = seed();
    const result = await send(db, { toPhone: "+12065550111", attestVendorRelationship: true });
    expect(result.status).toBe(409);
    expect(hoisted.enqueue).not.toHaveBeenCalled();
    expect(hoisted.ledger!.events).toHaveLength(0);
  });

  it("refuses a vendor with no saved phone", async () => {
    const db = seed({ phone: "" });
    const result = await send(db, { attestVendorRelationship: true });
    expect(result.status).toBe(409);
    expect(hoisted.enqueue).not.toHaveBeenCalled();
  });

  it("refuses an inactive or unknown roster row", async () => {
    expect((await send(seed({ active: false }), { attestVendorRelationship: true })).status).toBe(404);
    expect((await send(seed(), { vendorRecordId: "nope", attestVendorRelationship: true })).status).toBe(404);
  });

  it("refuses a manager with no edit access to the roster owner", async () => {
    const db = seed();
    hoisted.scope.mockResolvedValue(["someone-else"]);
    const result = await send(db, { actorUserId: "intruder", attestVendorRelationship: true });
    expect(result.status).toBe(403);
    expect(hoisted.enqueue).not.toHaveBeenCalled();
  });

  it("uses the line a vendor thread already has", async () => {
    const db = seed();
    db.__tables.sms_projection_conversations!.push({
      owner_manager_user_id: OWNER, counterparty_role: "vendor", counterparty_phone: PHONE, work_line_id: "line-existing", merged_into_id: null, last_event_at: "2026-10-05T00:00:00Z",
    });
    await send(db, { attestVendorRelationship: true });
    expect(hoisted.enqueue.mock.calls[0]![0].selectedWorkLineId).toBe("line-existing");
  });

  it("the credit gate stays the dispatcher's: a refused enqueue is reported, nothing is sent", async () => {
    const db = seed();
    hoisted.enqueue.mockResolvedValue({ ok: false, error: "comms_billing_insufficient_credit" });
    const result = await send(db, { attestVendorRelationship: true });
    expect(result.status).toBe(503);
    expect(hoisted.dispatch).not.toHaveBeenCalled();
  });
});

describe("a vendor thread already on screen", () => {
  it("replies on the vendor consent purpose, and a vendor who texted before consent was recorded is opted in by that text", async () => {
    const db = seed();
    db.__tables.inbound_sms_log!.push({ manager_user_id: OWNER, from_phone: PHONE, message_sid: "SMold", created_at: "2026-10-01T00:00:00Z" });
    const result = await sendManagerConversationSms(db as never, {
      actorUserId: ACTOR,
      toPhone: PHONE,
      text: "Thursday works.",
      idempotencyKey: "vendor_thread_reply_01",
      selectedConversation: {
        projectionId: "proj-1", workLineId: "line-1", ownerManagerUserId: OWNER, residentUserId: null, residentEmail: null,
        name: "Mike's Plumbing", phone: PHONE, propertyLabel: null, counterpartyRole: "vendor", conversationKey: `${OWNER}:vendor:${PHONE}`, messages: [],
      },
    });

    expect(result.status).toBe(200);
    expect(hoisted.enqueue.mock.calls[0]![0]).toMatchObject({ purpose: "vendor_conversation", counterpartyRole: "vendor" });
    expect(hoisted.ledger!.events).toEqual([
      expect.objectContaining({ eventType: "granted", source: "recipient_initiated_inbound", evidence: { messageSid: "SMold", role: "vendor" } }),
    ]);
  });

  it("a resident thread keeps the generic purpose", async () => {
    const db = seed();
    await sendManagerConversationSms(db as never, {
      actorUserId: ACTOR, toPhone: "+12065550177", text: "Hi", idempotencyKey: "resident_reply_000001",
      selectedConversation: {
        projectionId: "proj-2", workLineId: "line-1", ownerManagerUserId: OWNER, residentUserId: "res-1", residentEmail: "r@x.co",
        name: "Riley", phone: "+12065550177", propertyLabel: null, counterpartyRole: "resident", conversationKey: "K", messages: [],
      },
    });
    expect(hoisted.enqueue.mock.calls[0]![0].purpose).toBe("manager_conversation");
  });
});

describe("the status the compose modal reads", () => {
  it("offers the attestation (and the exact sender line) only for a vendor with no consent", async () => {
    const db = seed();
    const fresh = await readRosterVendorTextStatus(db as never, { actorUserId: ACTOR, vendorRecordId: VENDOR_ROW });
    expect(fresh.body).toMatchObject({ needsAttestation: true, optedOut: false, senderLine: LINE_FOOTER, phone: PHONE });

    await hoisted.ledger!.module.recordScopedSmsConsent(PHONE, {
      managerUserId: OWNER, purpose: "vendor_conversation", sendClass: "transactional",
      conversationKey: `${OWNER}:vendor:${PHONE}`, messagingServiceSid: "MGtest", eventType: "granted", source: "recipient_initiated_inbound",
    });
    const known = await readRosterVendorTextStatus(db as never, { actorUserId: ACTOR, vendorRecordId: VENDOR_ROW });
    expect(known.body).toMatchObject({ needsAttestation: false, optedOut: false });
    expect(known.body).not.toHaveProperty("senderLine");
  });

  it("reports an opted-out number", async () => {
    const db = seed();
    hoisted.ledger!.stop(PHONE);
    const status = await readRosterVendorTextStatus(db as never, { actorUserId: ACTOR, vendorRecordId: VENDOR_ROW });
    expect(status.body).toMatchObject({ optedOut: true, needsAttestation: false });
  });
});
