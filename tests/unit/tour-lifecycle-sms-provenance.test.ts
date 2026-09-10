import { beforeEach, describe, expect, it, vi } from "vitest";

const sendResidentOutboundSms = vi.fn(async () => ({ sent: true, sid: "SM-tour", channel: "claw" as const }));
const syncPlannedTourToGoogleCalendar = vi.fn(async () => "gcal-new");
const fetchEmail = vi.fn(async () => new Response(JSON.stringify({ id: "email-tour" }), { status: 200 }));

vi.mock("@/lib/resident-outbound-sms.server", () => ({
  sendResidentOutboundSms: (...args: unknown[]) => sendResidentOutboundSms(...(args as [])),
}));
vi.mock("@/lib/google-calendar/sync.server", () => ({
  syncPlannedTourToGoogleCalendar: (...args: unknown[]) => syncPlannedTourToGoogleCalendar(...(args as [])),
  deleteProplaneGoogleCalendarEvent: vi.fn(async () => undefined),
}));
vi.mock("@/lib/manager-default-tasks.server", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createPrepareForTourTask: vi.fn(async () => undefined),
}));

import { buildReplyAddress } from "@/lib/inbound-email/reply-address.server";
import { confirmTourInquiry } from "@/lib/tour-inquiry-confirm.server";
import { acceptTourInquiry } from "@/lib/tour-inquiry.server";
import { cancelPlannedTour, reschedulePlannedTour } from "@/lib/tour-planned-change.server";

const INQUIRIES_RECORD_ID = "axis_admin_partner_inquiries_v1";
const PLANNED_RECORD_ID = "axis_admin_planned_events_v1";
const MANAGER = "00000000-0000-4000-8000-000000000001";
const GUEST = "guest@example.com";
const PHONE = "+12065550100";
const START = "2099-08-06T17:00:00.000Z";
const END = "2099-08-06T18:00:00.000Z";
const NEXT_START = "2099-08-07T17:00:00.000Z";
const NEXT_END = "2099-08-07T18:00:00.000Z";
const CONVERSATION_KEY = `${MANAGER}:prospect:${PHONE}`;

type ConsentEvent = Record<string, unknown>;

function inquiry(overrides: Record<string, unknown> = {}) {
  return {
    id: "inq-tour-lifecycle",
    kind: "tour",
    status: "pending",
    name: "Tour Guest",
    email: GUEST,
    phone: PHONE,
    smsConsent: false,
    smsOrigin: "non_sms",
    managerUserId: MANAGER,
    eligibleHostUserIds: [MANAGER],
    propertyId: "prop-1",
    propertyTitle: "Ballard House",
    proposedStart: START,
    proposedEnd: END,
    requestedWindows: [{ start: START, end: END, slotKey: "2099-08-06:34", managerUserId: MANAGER }],
    ...overrides,
  };
}

function makeDb(options: {
  inquiry?: Record<string, unknown>;
  planned?: Record<string, unknown>[];
  consentEvents?: ConsentEvent[];
} = {}) {
  const records = new Map<string, { payload: Record<string, unknown>[]; updatedAt: string }>([
    [INQUIRIES_RECORD_ID, { payload: [options.inquiry ?? inquiry()], updatedAt: "2099-08-01T12:00:00.000Z" }],
    [PLANNED_RECORD_ID, { payload: options.planned ?? [], updatedAt: "2099-08-01T12:00:00.000Z" }],
  ]);
  const consentEvents = [...(options.consentEvents ?? [])];
  const inboxRows: Record<string, unknown>[] = [];
  let conversationLedgerReads = 0;

  const db = {
    from: (table: string) => {
      const filters = new Map<string, string>();
      let updateValue: Record<string, unknown> | null = null;
      const chain = {
        select: () => chain,
        eq: (column: string, value: string) => {
          filters.set(column, value);
          return chain;
        },
        in: () => chain,
        or: () => chain,
        order: () => chain,
        limit: () => chain,
        then: (resolve: (value: unknown) => unknown) => {
          if (table !== "sms_consent_events") return Promise.resolve(resolve({ data: [], error: null }));
          if (filters.get("purpose") === "manager_conversation") conversationLedgerReads += 1;
          const matches = consentEvents.filter((event) =>
            [...filters.entries()].every(([key, value]) => String(event[key] ?? "") === value),
          );
          return Promise.resolve(resolve({ data: matches.slice(0, 1), error: null }));
        },
        maybeSingle: async () => {
          if (table === "portal_schedule_records") {
            const record = records.get(filters.get("id") ?? "");
            return record
              ? { data: { row_data: { payload: structuredClone(record.payload) }, updated_at: record.updatedAt }, error: null }
              : { data: null, error: null };
          }
          if (table === "profiles") {
            if (filters.get("id") === MANAGER) return { data: { id: MANAGER, email: "manager@example.com", full_name: "Manager" }, error: null };
            if (filters.get("email") === GUEST) return { data: { id: "guest-user" }, error: null };
            return { data: null, error: null };
          }
          if (table === "manager_property_records") return { data: null, error: null };
          if (table === "manager_sms_numbers") return {
            data: {
              manager_user_id: MANAGER,
              phone_number: "+12065550999",
              provision_state: "active",
              registration_state: "approved",
              attachment_state: "attached",
              number_registration_state: "approved",
            },
            error: null,
          };
          if (table === "portal_inbox_thread_records") {
            const row = inboxRows.find((candidate) => candidate.id === filters.get("id"));
            return { data: row ?? null, error: null };
          }
          if (table === "sms_consent") return { data: null, error: null };
          return { data: null, error: null };
        },
        upsert: async (value: Record<string, unknown> | Record<string, unknown>[]) => {
          for (const row of Array.isArray(value) ? value : [value]) {
            if (table === "portal_schedule_records") {
              const payload = (row.row_data as { payload?: Record<string, unknown>[] })?.payload ?? [];
              records.set(String(row.id), { payload: structuredClone(payload), updatedAt: String(row.updated_at) });
            } else if (table === "portal_inbox_thread_records") {
              const index = inboxRows.findIndex((candidate) => candidate.id === row.id);
              if (index >= 0) inboxRows[index] = structuredClone(row);
              else inboxRows.push(structuredClone(row));
            }
          }
          return { error: null };
        },
        update: (value: Record<string, unknown>) => {
          updateValue = value;
          return chain;
        },
        insert: async (value: Record<string, unknown> | Record<string, unknown>[]) => {
          for (const row of Array.isArray(value) ? value : [value]) {
            if (table === "sms_consent_events") consentEvents.push(structuredClone(row));
            if (table === "portal_inbox_thread_records") inboxRows.push(structuredClone(row));
          }
          return { data: null, error: null };
        },
        delete: () => ({ in: async () => ({ error: null }) }),
      };
      const originalMaybeSingle = chain.maybeSingle;
      chain.maybeSingle = (async () => {
        if (updateValue && table === "portal_schedule_records") {
          const id = filters.get("id") ?? "";
          const record = records.get(id);
          if (!record || filters.get("updated_at") !== record.updatedAt) return { data: null, error: null };
          const payload = (updateValue.row_data as { payload?: Record<string, unknown>[] })?.payload ?? [];
          records.set(id, { payload: structuredClone(payload), updatedAt: String(updateValue.updated_at) });
          return { data: { id }, error: null };
        }
        return originalMaybeSingle();
      }) as typeof chain.maybeSingle;
      return chain;
    },
  };
  return {
    db: db as never,
    plannedRows: () => records.get(PLANNED_RECORD_ID)!.payload,
    inboxRows,
    consentEvents,
    conversationLedgerReads: () => conversationLedgerReads,
  };
}

describe("tour lifecycle SMS provenance", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", fetchEmail);
    process.env.TWILIO_MESSAGING_SERVICE_SID = "MG_test";
    process.env.RESEND_REPLY_DOMAIN = "reply.proplane.test";
    process.env.RESEND_INBOUND_WEBHOOK_SECRET = "whsec_dGVzdC1zZWNyZXQ=";
    process.env.RESEND_API_KEY = "re_test";
  });

  it("runs confirm -> planned reschedule through the real resolver and notifier for explicit opt-in", async () => {
    const store = makeDb({ inquiry: inquiry({ smsConsent: true, smsOrigin: "non_sms" }) });
    const confirmed = await acceptTourInquiry(store.db, MANAGER, { inquiryId: "inq-tour-lifecycle" });
    expect(confirmed.ok).toBe(true);
    const planned = store.plannedRows().at(-1)!;
    expect(planned).toMatchObject({ managerUserId: MANAGER, smsConsent: true, smsOrigin: "non_sms" });

    const changed = await reschedulePlannedTour(store.db, {
      plannedEventId: String(planned.id),
      actorUserId: MANAGER,
      start: NEXT_START,
      end: NEXT_END,
      notifyGuest: true,
      notificationChannels: { viaEmail: true, viaSms: true },
    });

    expect(changed.ok).toBe(true);
    expect(changed).toMatchObject({ guestNotification: { ok: true, inbox: { sent: true }, sms: { sent: true, channel: "claw" } } });
    expect(sendResidentOutboundSms).toHaveBeenCalledWith(expect.objectContaining({
      to: PHONE,
      openThread: expect.objectContaining({ managerUserId: MANAGER, conversationKey: CONVERSATION_KEY }),
      purpose: "tour_rescheduled",
    }));
    expect(sendResidentOutboundSms).toHaveBeenCalledTimes(1);
    expect(store.consentEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ manager_user_id: MANAGER, purpose: "tour_rescheduled", source: "tour_inquiry_opt_in" }),
    ]));
    expect(store.plannedRows().at(-1)?.guestRescheduleReply).toMatchObject({
      status: "awaiting_reply",
      smsEligibility: "eligible",
      conversationKey: CONVERSATION_KEY,
    });
    const inbox = store.inboxRows.find((row) => row.scope === "axis_portal_inbox_resident_v1");
    expect(inbox).toMatchObject({ owner_user_id: "guest-user", participant_email: GUEST, thread_type: "portal_message" });
    expect((inbox?.row_data as Record<string, unknown>)?.managerUserId).toBe(MANAGER);
    const emailBody = JSON.parse(String((fetchEmail.mock.calls[0]?.[1] as RequestInit | undefined)?.body));
    expect(emailBody.reply_to).toBe(buildReplyAddress(MANAGER, GUEST));
  });

  it("runs accept -> planned cancel through the real legacy conversation ledger path", async () => {
    const store = makeDb({
      inquiry: inquiry({ smsOrigin: "leasing_sms" }),
      consentEvents: [{
        recipient_phone_key: "2065550100",
        manager_user_id: MANAGER,
        messaging_service_sid: "MG_test",
        purpose: "manager_conversation",
        send_class: "transactional",
        conversation_key: CONVERSATION_KEY,
        event_type: "granted",
        source: "recipient_initiated_inbound",
        occurred_at: "2099-08-01T12:00:00.000Z",
      }],
    });
    const confirmed = await confirmTourInquiry(store.db, {
      inquiryId: "inq-tour-lifecycle",
      actorUserId: MANAGER,
      notifyTenant: false,
    });
    expect(confirmed.ok).toBe(true);
    const planned = store.plannedRows().at(-1)!;

    const canceled = await cancelPlannedTour(store.db, {
      plannedEventId: String(planned.id),
      actorUserId: MANAGER,
      notifyGuest: true,
      notificationChannels: { viaEmail: false, viaSms: true },
    });

    expect(canceled.ok).toBe(true);
    expect(canceled).toMatchObject({ guestNotification: { ok: true, inbox: { sent: true }, sms: { sent: true } } });
    expect(sendResidentOutboundSms).toHaveBeenCalledWith(expect.objectContaining({
      to: PHONE,
      openThread: expect.objectContaining({ managerUserId: MANAGER, conversationKey: CONVERSATION_KEY }),
      purpose: "tour_canceled",
    }));
    expect(store.conversationLedgerReads()).toBeGreaterThan(0);
    expect(store.consentEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ purpose: "tour_canceled", source: "recipient_initiated_inbound" }),
    ]));
  });

  it("runs confirm -> planned reschedule through legacy conversation evidence and records the reply proposal", async () => {
    const store = makeDb({
      inquiry: inquiry({ smsOrigin: "leasing_sms" }),
      consentEvents: [{
        recipient_phone_key: "2065550100",
        manager_user_id: MANAGER,
        messaging_service_sid: "MG_test",
        purpose: "manager_conversation",
        send_class: "transactional",
        conversation_key: CONVERSATION_KEY,
        event_type: "granted",
        source: "recipient_initiated_inbound",
        occurred_at: "2099-08-01T12:00:00.000Z",
      }],
    });
    const confirmed = await confirmTourInquiry(store.db, {
      inquiryId: "inq-tour-lifecycle", actorUserId: MANAGER, notifyTenant: false,
    });
    expect(confirmed.ok).toBe(true);
    const planned = store.plannedRows().at(-1)!;
    const changed = await reschedulePlannedTour(store.db, {
      plannedEventId: String(planned.id), actorUserId: MANAGER,
      start: NEXT_START, end: NEXT_END, notifyGuest: true,
      notificationChannels: { viaEmail: false, viaSms: true },
    });

    expect(changed).toMatchObject({ guestNotification: { ok: true, inbox: { sent: true }, sms: { sent: true } } });
    expect(sendResidentOutboundSms).toHaveBeenCalledWith(expect.objectContaining({
      openThread: expect.objectContaining({ managerUserId: MANAGER, conversationKey: CONVERSATION_KEY }),
      purpose: "tour_rescheduled",
    }));
    expect(store.plannedRows().at(-1)?.guestRescheduleReply).toMatchObject({
      status: "awaiting_reply", smsEligibility: "eligible", conversationKey: CONVERSATION_KEY,
    });
  });

  it("keeps a confirmed non-SMS tour ineligible despite matching historical conversation evidence", async () => {
    const store = makeDb({ consentEvents: [{
      recipient_phone_key: "2065550100",
      manager_user_id: MANAGER,
      messaging_service_sid: "MG_test",
      purpose: "manager_conversation",
      send_class: "transactional",
      conversation_key: CONVERSATION_KEY,
      event_type: "granted",
      source: "recipient_initiated_inbound",
      occurred_at: "2099-08-01T12:00:00.000Z",
    }] });
    const confirmed = await confirmTourInquiry(store.db, {
      inquiryId: "inq-tour-lifecycle",
      actorUserId: MANAGER,
      notifyTenant: false,
    });
    expect(confirmed.ok).toBe(true);
    const planned = store.plannedRows().at(-1)!;
    const changed = await reschedulePlannedTour(store.db, {
      plannedEventId: String(planned.id),
      actorUserId: MANAGER,
      start: NEXT_START,
      end: NEXT_END,
      notifyGuest: true,
      notificationChannels: { viaEmail: false, viaSms: true },
    });

    expect(changed).toMatchObject({
      ok: true,
      guestNotification: { sms: { requested: true, sent: false, skipped: true, error: "tour_sms_consent_missing" }, inbox: { sent: true } },
    });
    expect(sendResidentOutboundSms).not.toHaveBeenCalled();
    expect(store.conversationLedgerReads()).toBe(0);
    expect(store.inboxRows).toHaveLength(1);
  });

  it("keeps an accepted non-SMS tour ineligible on the real planned cancel caller", async () => {
    const store = makeDb({ consentEvents: [{
      recipient_phone_key: "2065550100",
      manager_user_id: MANAGER,
      messaging_service_sid: "MG_test",
      purpose: "manager_conversation",
      send_class: "transactional",
      conversation_key: CONVERSATION_KEY,
      event_type: "granted",
      source: "recipient_initiated_inbound",
      occurred_at: "2099-08-01T12:00:00.000Z",
    }] });
    const accepted = await acceptTourInquiry(store.db, MANAGER, { inquiryId: "inq-tour-lifecycle" });
    expect(accepted.ok).toBe(true);
    const planned = store.plannedRows().at(-1)!;
    const canceled = await cancelPlannedTour(store.db, {
      plannedEventId: String(planned.id), actorUserId: MANAGER, notifyGuest: true,
      notificationChannels: { viaEmail: false, viaSms: true },
    });
    expect(canceled).toMatchObject({
      ok: true,
      guestNotification: { sms: { requested: true, sent: false, skipped: true, error: "tour_sms_consent_missing" }, inbox: { sent: true } },
    });
    expect(sendResidentOutboundSms).not.toHaveBeenCalled();
    expect(store.conversationLedgerReads()).toBe(0);
  });
});
