/**
 * comms-safety-0929 Part C, delivery half: a vendor's text goes through the
 * owner dispatcher (fixing managed_sender_scope_required), needs the vendor's
 * consent and no STOP, waits for the vendor's quiet hours, and is deduped on a
 * stable key. In-app and email are never held back by any of it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

const { enqueueMock, optedOutMock, consentMock, vendorSettingsMock, sendResidentSmsMock } = vi.hoisted(() => ({
  enqueueMock: vi.fn(),
  optedOutMock: vi.fn(),
  consentMock: vi.fn(),
  vendorSettingsMock: vi.fn(),
  sendResidentSmsMock: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/push-notifications.server", () => ({ sendPushToUser: vi.fn().mockResolvedValue({ sent: 0 }) }));
vi.mock("@/lib/portal-email-send.server", () => ({
  sendPortalConversationEmails: vi.fn(async (args: { toEmails: string[] }) => new Map(args.toEmails.map((e) => [e, { sent: true }]))),
}));
vi.mock("@/lib/manager-outbound-identity.server", () => ({ resolveManagerOutboundFrom: async () => "Seattle Homes <mgr@work.test>" }));
vi.mock("@/lib/sms-consent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/sms-consent")>()),
  isPhoneOptedOut: (...args: unknown[]) => optedOutMock(...args),
}));
vi.mock("@/lib/sms/vendor-conversation-consent.server", () => ({
  ensureVendorConversationConsent: (...args: unknown[]) => consentMock(...args),
}));
vi.mock("@/lib/sms/owner-sms-dispatcher.server", () => ({
  enqueueOwnerSms: (...args: unknown[]) => enqueueMock(...args),
}));
vi.mock("@/lib/resident-outbound-sms.server", () => ({
  canSendResidentOutboundSms: () => true,
  sendResidentOutboundSms: (...args: unknown[]) => sendResidentSmsMock(...args),
}));
vi.mock("@/lib/vendor-notification-settings.server", () => ({
  loadVendorNotificationSettings: (...args: unknown[]) => vendorSettingsMock(...args),
}));

import {
  deliverPortalInboxMessage,
  isTransientOwnerSmsError,
  sendVendorEventSms,
} from "@/lib/portal-inbox-delivery";
import { emitActionEvent } from "@/lib/action-events.server";
import { DEFAULT_VENDOR_NOTIFICATION_SETTINGS } from "@/lib/vendor-notification-settings";

type Row = Record<string, unknown> & { id: string };

/** Fake DB covering the inbox write, profile lookups and the action-event tables. */
function makeDb(profiles: Row[]) {
  const tables: Record<string, Row[]> = {
    profiles: [...profiles],
    portal_inbox_thread_records: [],
    portal_outbound_mail_records: [],
    action_events: [],
    action_event_deliveries: [],
  };
  let seq = 0;
  const from = (table: string) => {
    const rows = () => (tables[table] ??= []);
    const filters: Array<(r: Row) => boolean> = [];
    let upserted: Row | null = null;
    let ignored = false;
    let mutation: Record<string, unknown> | null = null;
    let countOnly = false;
    const matched = () => rows().filter((r) => filters.every((f) => f(r)));
    const q: Record<string, unknown> = {
      select: (_c?: string, o?: { head?: boolean }) => {
        countOnly = o?.head === true;
        return q;
      },
      order: () => q,
      limit: () => q,
      gte: (c: string, v: string) => (filters.push((r) => String(r[c] ?? "") >= v), q),
      eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), q),
      in: (c: string, vs: unknown[]) => (filters.push((r) => vs.includes(r[c])), q),
      update: (p: Record<string, unknown>) => {
        mutation = p;
        return q;
      },
      upsert: (payload: Row, o?: { onConflict?: string; ignoreDuplicates?: boolean }) => {
        const keys = (o?.onConflict ?? "id").split(",");
        const existing = rows().find((r) => keys.every((k) => r[k] === payload[k]));
        if (existing && o?.ignoreDuplicates) ignored = true;
        else if (existing) upserted = Object.assign(existing, payload);
        else {
          upserted = { id: `${table}-${++seq}`, attempts: 0, created_at: new Date().toISOString(), ...payload } as Row;
          rows().push(upserted);
        }
        return q;
      },
      maybeSingle: () => {
        const selected = matched()[0] ?? null;
        if (mutation && selected) Object.assign(selected, mutation);
        return Promise.resolve({ data: ignored ? null : upserted ?? selected, error: null });
      },
      then: (resolve: (v: { data: Row[]; error: null; count?: number }) => unknown) => {
        if (upserted || ignored) return Promise.resolve({ data: [], error: null }).then(resolve);
        const data = matched();
        if (mutation) for (const r of data) Object.assign(r, mutation);
        return Promise.resolve({ data, error: null, ...(countOnly ? { count: data.length } : {}) }).then(resolve);
      },
    };
    return q;
  };
  return { db: { from } as unknown as SupabaseClient, tables };
}

// Role "admin" skips the connected-people scope check, which is not under test here.
const MANAGER = { id: "mgr-1", email: "mgr@seattle.test", role: "admin", full_name: "Seattle Homes" };
const vendorProfile = (over: Partial<Row> = {}): Row => ({
  id: "vendor-user-1",
  email: "north@vendor.test",
  role: "vendor",
  phone: "+12065550101",
  phone_verified_at: "2026-09-01T00:00:00.000Z",
  sms_consent_at: "2026-09-01T00:00:00.000Z",
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  optedOutMock.mockResolvedValue(false);
  consentMock.mockResolvedValue({ allowed: true, conversationKey: "ck-vendor-1" });
  enqueueMock.mockResolvedValue({ ok: true, outboxId: "ob-1", status: "queued", deduplicated: false });
  vendorSettingsMock.mockResolvedValue(DEFAULT_VENDOR_NOTIFICATION_SETTINGS);
});

describe("sendVendorEventSms: consent, STOP, dedupe, credit-bearing dispatcher", () => {
  const input = (over: Record<string, unknown> = {}) => ({
    ownerManagerUserId: "mgr-1",
    propertyId: "prop-1",
    vendorUserId: "vendor-user-1",
    body: "SRV-1: You were assigned “Leaking sink”.",
    dedupeKey: "vendor-event-sms:action-event:wo-1:vendor_assigned:vd-1:T:vendor:vendor-user-1",
    ...over,
  });

  it("queues through the owner dispatcher from the workspace owner with the stable dedupe key", async () => {
    const { db } = makeDb([MANAGER, vendorProfile()]);
    expect(await sendVendorEventSms(db, input())).toBe("queued");
    expect(consentMock).toHaveBeenCalledWith(db, expect.objectContaining({ managerUserId: "mgr-1", vendorUserId: "vendor-user-1", evidence: { consentAt: "2026-09-01T00:00:00.000Z" } }));
    expect(enqueueMock).toHaveBeenCalledTimes(1);
    expect(enqueueMock.mock.calls[0]![0]).toMatchObject({
      managerUserId: "mgr-1",
      actorUserId: "mgr-1",
      recipientPhone: "+12065550101",
      recipientUserId: "vendor-user-1",
      sendClass: "transactional",
      purpose: "vendor_conversation",
      counterpartyRole: "vendor",
      conversationKey: "ck-vendor-1",
      propertyId: "prop-1",
      dedupeKey: "vendor-event-sms:action-event:wo-1:vendor_assigned:vd-1:T:vendor:vendor-user-1",
    });
  });

  it("no recorded consent: no text, nothing queued", async () => {
    const { db } = makeDb([MANAGER, vendorProfile({ sms_consent_at: null })]);
    expect(await sendVendorEventSms(db, input())).toBe("skipped");
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it("STOP: no text, nothing queued", async () => {
    optedOutMock.mockResolvedValue(true);
    const { db } = makeDb([MANAGER, vendorProfile()]);
    expect(await sendVendorEventSms(db, input())).toBe("skipped");
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it("a revoked ledger consent: no text", async () => {
    consentMock.mockResolvedValue({ allowed: false, conversationKey: "ck" });
    const { db } = makeDb([MANAGER, vendorProfile()]);
    expect(await sendVendorEventSms(db, input())).toBe("skipped");
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it("a standing refusal (credit, paused runtime) is skipped; a transient read error is retried", async () => {
    const { db } = makeDb([MANAGER, vendorProfile()]);
    enqueueMock.mockResolvedValueOnce({ ok: false, error: "comms_billing_insufficient_credit" });
    expect(await sendVendorEventSms(db, input())).toBe("skipped");
    enqueueMock.mockResolvedValueOnce({ ok: false, error: "runtime_env_paused" });
    expect(await sendVendorEventSms(db, input())).toBe("skipped");
    enqueueMock.mockResolvedValueOnce({ ok: false, error: "control_plane_unreadable" });
    expect(await sendVendorEventSms(db, input())).toBe("failed");
    expect(isTransientOwnerSmsError("scoped_consent_missing")).toBe(false);
  });

  it("a vendor with no account or phone gets no text", async () => {
    const { db } = makeDb([MANAGER, vendorProfile({ phone: "" })]);
    expect(await sendVendorEventSms(db, input())).toBe("skipped");
    expect(await sendVendorEventSms(db, input({ vendorUserId: null }))).toBe("skipped");
    expect(enqueueMock).not.toHaveBeenCalled();
  });
});

describe("deliverPortalInboxMessage to a vendor: the text no longer dies on the resident path", () => {
  // The SMS leg runs through the vendor's own quiet hours (default 8pm-7am
  // Pacific), read off the clock: unpinned, every "queues the text" assertion
  // below silently inverts after 8pm Pacific. Noon PDT keeps the window open.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-29T19:00:00.000Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const base = {
    senderUserId: "mgr-1",
    senderEmail: "mgr@seattle.test",
    fromName: "Seattle Homes",
    senderRole: "admin" as const,
    subject: "SRV-1 · Leaking sink",
    text: "SRV-1: You were assigned “Leaking sink”.",
    toUserIds: ["vendor-user-1"],
    eventCategory: "maintenance" as const,
    vendorTopic: "schedule" as const,
    automated: true,
    messageId: "action-event:wo-1:vendor_assigned:vd-1:T:vendor:vendor-user-1",
  };

  it("writes the in-app message, emails, and queues the text via enqueueOwnerSms (not sendResidentOutboundSms)", async () => {
    const { db, tables } = makeDb([MANAGER, vendorProfile()]);
    const result = await deliverPortalInboxMessage(db, { ...base, ownerManagerUserId: "mgr-1", propertyId: "prop-1" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.smsOutcomes).toEqual([{ recipientEmail: "north@vendor.test", status: "queued" }]);
      expect(result.emailOutcomes).toEqual([{ recipientEmail: "north@vendor.test", status: "submitted" }]);
    }
    expect(tables.portal_inbox_thread_records.length).toBeGreaterThan(0);
    expect(enqueueMock).toHaveBeenCalledTimes(1);
    expect(enqueueMock.mock.calls[0]![0]).toMatchObject({
      managerUserId: "mgr-1",
      dedupeKey: `vendor-event-sms:${base.messageId}`,
      propertyId: "prop-1",
    });
    expect(sendResidentSmsMock).not.toHaveBeenCalled();
  });

  it("texts from the workspace owner when a co-manager sent it", async () => {
    const { db } = makeDb([MANAGER, vendorProfile(), { id: "co-1", email: "co@seattle.test", role: "admin" }]);
    await deliverPortalInboxMessage(db, { ...base, senderUserId: "co-1", senderEmail: "co@seattle.test", ownerManagerUserId: "mgr-1" });
    expect(enqueueMock.mock.calls[0]![0]).toMatchObject({ managerUserId: "mgr-1", actorUserId: "mgr-1" });
  });

  it("no consent: in-app and email still go, no text", async () => {
    const { db, tables } = makeDb([MANAGER, vendorProfile({ sms_consent_at: null })]);
    const result = await deliverPortalInboxMessage(db, { ...base, ownerManagerUserId: "mgr-1" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      // A standing "no" reports no text outcome at all, so the bus has nothing to retry.
      expect(result.smsOutcomes).toEqual([]);
      expect(result.emailOutcomes[0]!.status).toBe("submitted");
    }
    expect(tables.portal_inbox_thread_records.length).toBeGreaterThan(0);
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it("STOP: in-app and email still go, no text", async () => {
    optedOutMock.mockResolvedValue(true);
    const { db } = makeDb([MANAGER, vendorProfile()]);
    const result = await deliverPortalInboxMessage(db, { ...base, ownerManagerUserId: "mgr-1" });
    expect(result.ok).toBe(true);
    // The channel gate closes the text (STOP); nothing is ever queued.
    if (result.ok) expect(result.smsOutcomes.every((o) => o.status === "unavailable")).toBe(true);
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it("inside the vendor's quiet hours the text is reported unavailable, never queued", async () => {
    vi.setSystemTime(new Date("2026-09-30T03:30:00.000Z")); // 8:30pm PDT
    const { db, tables } = makeDb([MANAGER, vendorProfile()]);
    const result = await deliverPortalInboxMessage(db, { ...base, ownerManagerUserId: "mgr-1", propertyId: "prop-1" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.smsOutcomes).toEqual([{ recipientEmail: "north@vendor.test", status: "unavailable" }]);
    expect(enqueueMock).not.toHaveBeenCalled();
    expect(tables.portal_inbox_thread_records.length).toBeGreaterThan(0);
  });

  it("a retry of the same event carries the same dedupe key (the dispatcher then queues nothing new)", async () => {
    const { db } = makeDb([MANAGER, vendorProfile()]);
    await deliverPortalInboxMessage(db, { ...base, ownerManagerUserId: "mgr-1" });
    await deliverPortalInboxMessage(db, { ...base, ownerManagerUserId: "mgr-1", suppressInbox: true, suppressEmail: true });
    const keys = enqueueMock.mock.calls.map((c) => (c[0] as { dedupeKey: string }).dedupeKey);
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(1);
  });
});

describe("emitActionEvent to a vendor after 8pm", () => {
  const vendorEvent = (over: Record<string, unknown> = {}) => ({
    eventId: `wo-1:vendor_assigned:vd-1:${Math.random()}`,
    domain: "work_order" as const,
    event: "vendor_assigned",
    managerUserId: "mgr-1",
    entityId: "wo-1",
    category: "maintenance" as const,
    senderUserId: "mgr-1",
    senderEmail: "mgr@seattle.test",
    payload: { propertyId: "prop-1" },
    recipients: [{ audience: "vendor" as const, userId: "vendor-user-1", email: "north@vendor.test", rendered: { subject: "SRV-1", text: "SRV-1: You were assigned." } }],
    ...over,
  });

  it("queues the delivery as deferred to 7:00am Pacific; the portal and email legs go in the first pass", async () => {
    const emit = emitActionEvent;
    const { db, tables } = makeDb([MANAGER, vendorProfile()]);
    // 8:05pm PDT on Sep 29 -> default workspace quiet hours (9pm) have not begun.
    const now = new Date("2026-09-30T03:05:00.000Z");
    const result = await emit(db, vendorEvent({ now }));
    expect(result.deferred + result.delivered + result.submitted).toBe(1);
    const delivery = tables.action_event_deliveries[0]!;
    expect(delivery.status).toBe("deferred");
    expect(delivery.next_attempt_at).toBe("2026-09-30T14:00:00.000Z"); // 7:00am PDT
  });

  it("an emergency texts at once when the vendor kept the bypass on, and waits when they did not", async () => {
    const emit = emitActionEvent;
    const now = new Date("2026-09-30T03:05:00.000Z");

    const first = makeDb([MANAGER, vendorProfile()]);
    await emit(first.db, vendorEvent({ now, urgent: true }));
    expect(first.tables.action_event_deliveries[0]!.status).not.toBe("deferred");

    vendorSettingsMock.mockResolvedValue({ ...DEFAULT_VENDOR_NOTIFICATION_SETTINGS, emergencyBypassQuietHours: false });
    const second = makeDb([MANAGER, vendorProfile()]);
    await emit(second.db, vendorEvent({ now, urgent: true }));
    expect(second.tables.action_event_deliveries[0]!.status).toBe("deferred");
    expect(second.tables.action_event_deliveries[0]!.next_attempt_at).toBe("2026-09-30T14:00:00.000Z");
  });

  it("midday is not deferred", async () => {
    const emit = emitActionEvent;
    const { db, tables } = makeDb([MANAGER, vendorProfile()]);
    await emit(db, vendorEvent({ now: new Date("2026-09-29T19:00:00.000Z") }));
    expect(tables.action_event_deliveries[0]!.status).not.toBe("deferred");
  });

  it("an unreadable vendor settings row never silences the message", async () => {
    vendorSettingsMock.mockRejectedValue(new Error("boom"));
    const emit = emitActionEvent;
    const { db, tables } = makeDb([MANAGER, vendorProfile()]);
    await emit(db, vendorEvent({ now: new Date("2026-09-29T19:00:00.000Z") }));
    expect(tables.action_event_deliveries[0]!.status).not.toBe("failed");
  });
});
