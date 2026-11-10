import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listOpenTourSlots: vi.fn(),
  confirmProspectSmsTourOffer: vi.fn(),
  loadConfirmedProspectTourBooking: vi.fn(),
  recoverProspectTourBookingSideEffects: vi.fn(),
}));

vi.mock("@/lib/tour-availability.server", () => ({
  listOpenTourSlots: mocks.listOpenTourSlots,
}));
vi.mock("@/lib/tour-schedule-persistence.server", () => ({
  confirmProspectSmsTourOffer: mocks.confirmProspectSmsTourOffer,
}));
vi.mock("@/lib/prospect-tour-booking-recovery.server", () => ({
  loadConfirmedProspectTourBooking: mocks.loadConfirmedProspectTourBooking,
  recoverProspectTourBookingSideEffects: mocks.recoverProspectTourBookingSideEffects,
}));
vi.mock("@/lib/sms-conversation-identity", () => ({
  buildConversationKey: () => "manager:prospect:+12065550123",
}));

import { confirmProspectSmsTourTool } from "@/lib/tools/domains/tours";

const MANAGER = "11111111-1111-4111-8111-111111111111";
const PHONE = "+12065550123";
const OFFER = {
  slotKey: "2099-09-10:20",
  start: "2099-09-10T17:00:00.000Z",
  end: "2099-09-10T17:30:00.000Z",
  label: "Thursday, September 10, 2099 at 10:00 AM Pacific",
  hostUserId: MANAGER,
};

type Ingress = {
  source_message_id: string;
  burst_id: string;
  burst_revision: number;
  body: string;
  received_at: string;
};

/**
 * A small Supabase query double that honors equality and `in` predicates.
 * This is deliberately not a "return all rows" mock: the old bug narrowed
 * the query to the newest revision, and this fake must expose that mistake.
 */
function dbFor(rows: Ingress[]) {
  const db = {
    from(table: string) {
      if (table !== "prospect_sms_ingress") throw new Error(`unexpected table ${table}`);
      const predicates: { column: string; value: unknown }[] = [];
      let ids: Set<string> | null = null;
      const query: Record<string, unknown> = {};
      query.select = () => query;
      query.eq = (column: string, value: unknown) => {
        predicates.push({ column, value });
        return query;
      };
      query.in = (column: string, values: string[]) => {
        if (column === "source_message_id") ids = new Set(values);
        return query;
      };
      query.order = () => query;
      query.then = (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) => {
        const data = rows
          .filter((row) => predicates.every(({ column, value }) => row[column as keyof Ingress] === value))
          .filter((row) => !ids || ids.has(row.source_message_id))
          .sort((a, b) => a.received_at.localeCompare(b.received_at));
        return Promise.resolve({ data, error: null }).then(resolve, reject);
      };
      return query;
    },
  };
  return db as never;
}

function contextFor(rows: Ingress[], revision = 9) {
  return {
    landlordId: MANAGER,
    userId: MANAGER,
    email: "",
    roles: ["leasing_sms_agent"],
    isAdmin: false,
    db: dbFor(rows),
    leasingScope: {
      sessionId: "session-1",
      prospectPhoneE164: PHONE,
      workNumber: "+12055550100",
      prospectBurst: {
        burstId: "burst-1",
        revision,
        workerId: "worker-1",
        claimedSourceIds: rows.map((row) => row.source_message_id),
      },
    },
  };
}

function input() {
  return {
    propertyId: "property-1",
    propertyTitle: "Ballard House",
    slotKey: OFFER.slotKey,
    start: OFFER.start,
    end: OFFER.end,
    hostUserId: MANAGER,
    name: "Jordan Lee",
  };
}

function ingress(body: string, revision: number, id: string): Ingress {
  return {
    source_message_id: id,
    burst_id: "burst-1",
    burst_revision: revision,
    body,
    received_at: `2099-09-10T${String(revision).padStart(2, "0")}:00:00.000Z`,
  };
}

async function invoke(rows: Ingress[]) {
  return confirmProspectSmsTourTool.handler(contextFor(rows) as never, input());
}

describe("prospect SMS confirmation agreement source", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listOpenTourSlots.mockResolvedValue({
      ok: true,
      slotHosts: { [OFFER.slotKey]: [{ userId: MANAGER, label: "Akhil" }] },
      resolution: "resolved",
    });
    mocks.loadConfirmedProspectTourBooking.mockResolvedValue(null);
    mocks.confirmProspectSmsTourOffer.mockResolvedValue({
      ok: true,
      idempotent: false,
      plannedEventId: "planned-1",
      status: "confirmed",
    });
    mocks.recoverProspectTourBookingSideEffects.mockResolvedValue({
      calendarSync: { ok: true, skipped: true },
      managerNotification: { ok: true, suppressed: true },
    });
  });

  it.each([
    ["correction then YES", [ingress("Friday at 3 pm", 8, "friday"), ingress("YES", 9, "yes")]],
    ["YES then correction", [ingress("YES", 8, "yes"), ingress("Friday at 3 pm", 9, "friday")]],
    ["no then YES", [ingress("no", 8, "no"), ingress("YES", 9, "yes")]],
    ["changed property then YES", [ingress("Change the property to Jain Home", 8, "property"), ingress("YES", 9, "yes")]],
    ["same-body YES with another time", [ingress("YES, Tuesday at 10", 9, "mixed")]],
    ["contact-only follow-up after an earlier YES", [ingress("YES", 8, "yes"), ingress("My email is jordan@example.test", 9, "email")]],
  ])("does not book when the claimed snapshot revises or ambiguously follows the offer: %s", async (_label, rows) => {
    await expect(invoke(rows)).rejects.toThrow(/affirm the exact confirmation question/i);
    expect(mocks.confirmProspectSmsTourOffer).not.toHaveBeenCalled();
  });

  it("accepts a pure later YES from the complete claimed snapshot", async () => {
    const rows = [ingress("YES", 9, "yes")];
    mocks.loadConfirmedProspectTourBooking
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ status: "confirmed", planned_event_id: "planned-1", offer_snapshot: OFFER });
    await expect(invoke(rows)).resolves.toMatchObject({ booking: { status: "confirmed" } });
    expect(mocks.confirmProspectSmsTourOffer).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      agreementSourceMessageId: "yes",
      burstRevision: 9,
    }));
  });

  it("accepts two harmless affirmations but performs one booking write", async () => {
    const rows = [ingress("yes", 8, "yes-1"), ingress("yes please", 9, "yes-2")];
    mocks.loadConfirmedProspectTourBooking
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ status: "confirmed", planned_event_id: "planned-1", offer_snapshot: OFFER });
    await expect(invoke(rows)).resolves.toMatchObject({ booking: { status: "confirmed" } });
    expect(mocks.confirmProspectSmsTourOffer).toHaveBeenCalledOnce();
  });
});
