import { beforeEach, describe, expect, it, vi } from "vitest";

const resolveActiveManagerSendNumber = vi.fn(async () => "+12065550999");
const notifyManagerFromAgent = vi.fn(async () => ({ delivered: true, suppressed: false }));
vi.mock("@/lib/sms/manager-number-provisioning.server", () => ({
  resolveActiveManagerSendNumber: (...args: unknown[]) => resolveActiveManagerSendNumber(...(args as [])),
}));
vi.mock("@/lib/agent-notify.server", () => ({
  notifyManagerFromAgent: (...args: unknown[]) => notifyManagerFromAgent(...(args as [])),
}));

import {
  handleTourRescheduleSmsReply,
  nextTourScheduleCasTimestamp,
  recordTourRescheduleSmsProposal,
  TOUR_INQUIRIES_RECORD_ID,
} from "@/lib/tour-reschedule-sms-reply.server";

const start = "2026-09-12T18:00:00.000Z";
const end = "2026-09-12T18:30:00.000Z";

function event(overrides: Record<string, unknown> = {}) {
  return {
    id: "tour-1",
    sourceInquiryId: "inquiry-1",
    managerUserId: "manager-1",
    attendeePhone: "+12065550100",
    smsConsent: true,
    propertyTitle: "Maple House",
    start,
    end,
    ...overrides,
  };
}

function makeDb(initialRows: Record<string, unknown>[], onRead?: (readCount: number, rows: Record<string, unknown>[]) => void, inquiryRows = initialRows) {
  const records = new Map([
    ["axis_admin_planned_events_v1", { rows: structuredClone(initialRows), updatedAt: "2026-09-08T12:00:00.000Z" }],
    [TOUR_INQUIRIES_RECORD_ID, { rows: structuredClone(inquiryRows), updatedAt: "2026-09-08T12:00:00.000Z" }],
  ]);
  let readCount = 0;
  const db = {
    from(table: string) {
      if (table !== "portal_schedule_records") throw new Error(`Unexpected table ${table}`);
      const state: { update?: Record<string, unknown>; expectedUpdatedAt?: string; recordId?: string } = {};
      const chain = {
        select: () => chain,
        eq: (column: string, value: string) => {
          if (column === "id") state.recordId = value;
          if (column === "updated_at") state.expectedUpdatedAt = value;
          return chain;
        },
        update: (value: Record<string, unknown>) => {
          state.update = value;
          return chain;
        },
        maybeSingle: async () => {
          const record = records.get(state.recordId ?? "axis_admin_planned_events_v1")!;
          if (!state.update) {
            readCount += 1;
            onRead?.(readCount, record.rows);
            return { data: { row_data: { payload: structuredClone(record.rows) }, updated_at: record.updatedAt }, error: null };
          }
          if (state.expectedUpdatedAt !== record.updatedAt) return { data: null, error: null };
          record.rows = structuredClone(((state.update.row_data as { payload: Record<string, unknown>[] }).payload));
          record.updatedAt = String(state.update.updated_at);
          return { data: { id: "axis_admin_planned_events_v1" }, error: null };
        },
      };
      return chain;
    },
  };
  return {
    db: db as never,
    rows: () => records.get("axis_admin_planned_events_v1")!.rows,
    inquiryRows: () => records.get(TOUR_INQUIRIES_RECORD_ID)!.rows,
  };
}

describe("tour reschedule SMS replies", () => {
  beforeEach(() => {
    resolveActiveManagerSendNumber.mockClear();
    notifyManagerFromAgent.mockClear();
  });

  it("always advances the CAS token even for two writes in the same millisecond", () => {
    const first = nextTourScheduleCasTimestamp("2026-09-08T12:00:00.000Z", Date.parse("2026-09-08T12:00:00.000Z"));
    expect(first).toBe("2026-09-08T12:00:00.001Z");
    expect(nextTourScheduleCasTimestamp("not-a-date", Date.parse("2026-09-08T12:00:00.000Z"))).toBeNull();
    expect(nextTourScheduleCasTimestamp(first!, Date.parse("2026-09-08T12:00:00.000Z")))
      .toBe("2026-09-08T12:00:00.002Z");
  });

  it("fails closed when proposal lookup is unavailable", async () => {
    const chain = {
      select: () => chain,
      eq: () => chain,
      maybeSingle: async () => ({ data: null, error: { message: "db unavailable" } }),
    };
    const db = { from: () => chain } as never;
    await expect(handleTourRescheduleSmsReply(db, {
      managerUserId: "manager-1", fromPhone: "+12065550100", toPhone: "+12065550999", body: "YES", messageSid: "SM-error",
    })).resolves.toMatchObject({ handled: true, kind: "unavailable" });
  });

  it("fails closed when the inquiry inventory cannot be loaded after planned tours", async () => {
    let recordId = "";
    const chain = {
      select: () => chain,
      eq: (column: string, value: string) => { if (column === "id") recordId = value; return chain; },
      maybeSingle: async () => recordId === TOUR_INQUIRIES_RECORD_ID
        ? { data: null, error: { message: "inquiries unavailable" } }
        : { data: { row_data: { payload: [] } }, error: null },
    };
    await expect(handleTourRescheduleSmsReply({ from: () => chain } as never, {
      managerUserId: "manager-1", fromPhone: "+12065550100", toPhone: "+12065550999", body: "YES", messageSid: "SM-inquiry-error",
    })).resolves.toMatchObject({ handled: true, kind: "unavailable" });
  });

  it("records an exact actionable proposal only after delivery accepts it", async () => {
    const store = makeDb([event()]);
    await expect(recordTourRescheduleSmsProposal(store.db, {
      managerUserId: "manager-1", inquiryId: "inquiry-1", phone: "206-555-0100", start, end,
    })).resolves.toBe(true);
    expect((store.rows()[0]?.guestRescheduleReply as { status: string }).status).toBe("awaiting_reply");
    expect(store.rows()[0]?.guestRescheduleReply).toMatchObject({
      status: "awaiting_reply", phoneE164: "+12065550100", workNumber: "+12065550999",
    });
    await expect(recordTourRescheduleSmsProposal(store.db, {
      managerUserId: "manager-1", inquiryId: "inquiry-1", phone: "+12065550100", start, end,
    })).resolves.toBe(true);
  });

  it("does not reopen a terminal proposal when the same outbound delivery is retried", async () => {
    const store = makeDb([event()]);
    const proposalInput = { managerUserId: "manager-1", inquiryId: "inquiry-1", phone: "+12065550100", start, end };
    await recordTourRescheduleSmsProposal(store.db, proposalInput);
    await handleTourRescheduleSmsReply(store.db, {
      managerUserId: "manager-1", fromPhone: "+12065550100", toPhone: "+12065550999", body: "YES", messageSid: "SM-terminal",
    });
    await expect(recordTourRescheduleSmsProposal(store.db, proposalInput)).resolves.toBe(true);
    expect((store.rows()[0]?.guestRescheduleReply as { status: string }).status).toBe("confirmed");
  });

  it("creates a new reply generation when the manager work number rotates", async () => {
    const store = makeDb([event()]);
    resolveActiveManagerSendNumber.mockResolvedValueOnce("+12065550999").mockResolvedValueOnce("+12065550888");
    const proposalInput = { managerUserId: "manager-1", inquiryId: "inquiry-1", phone: "+12065550100", start, end };
    await recordTourRescheduleSmsProposal(store.db, proposalInput);
    (store.rows()[0]?.guestRescheduleReply as { status: string }).status = "confirmed";
    const firstVersion = (store.rows()[0]?.guestRescheduleReply as { version: string }).version;
    await expect(recordTourRescheduleSmsProposal(store.db, proposalInput)).resolves.toBe(true);
    expect(store.rows()[0]?.guestRescheduleReply).toMatchObject({ status: "awaiting_reply", workNumber: "+12065550888" });
    expect((store.rows()[0]?.guestRescheduleReply as { version: string }).version).not.toBe(firstVersion);
  });

  it("does not replace the persisted sender snapshot on a same-generation retry", async () => {
    const store = makeDb([event()]);
    resolveActiveManagerSendNumber.mockResolvedValueOnce("+12065550999").mockResolvedValueOnce("+12065550888");
    const proposalInput = {
      managerUserId: "manager-1", inquiryId: "inquiry-1", phone: "+12065550100", start, end,
      generation: "persisted-reschedule-generation",
    };
    await recordTourRescheduleSmsProposal(store.db, proposalInput);
    (store.rows()[0]?.guestRescheduleReply as { status: string }).status = "confirmed";
    await expect(recordTourRescheduleSmsProposal(store.db, proposalInput)).resolves.toBe(true);
    expect(store.rows()[0]?.guestRescheduleReply).toMatchObject({
      status: "confirmed", workNumber: "+12065550999", generation: "persisted-reschedule-generation",
    });
  });

  it("confirms one exact manager, phone, work-number, and current-window match", async () => {
    const store = makeDb([event()]);
    await recordTourRescheduleSmsProposal(store.db, {
      managerUserId: "manager-1", inquiryId: "inquiry-1", phone: "+12065550100", start, end,
    });
    const result = await handleTourRescheduleSmsReply(store.db, {
      managerUserId: "manager-1", fromPhone: "+12065550100", toPhone: "+12065550999", body: "YES", messageSid: "SM-1",
    });
    expect(result).toMatchObject({ handled: true, kind: "confirmed" });
    expect(store.rows()[0]?.guestRescheduleReply).toMatchObject({ status: "confirmed", inboundMessageSid: "SM-1" });
    await expect(handleTourRescheduleSmsReply(store.db, {
      managerUserId: "manager-1", fromPhone: "+12065550100", toPhone: "+12065550999", body: "YES", messageSid: "SM-1-later",
    })).resolves.toMatchObject({ handled: true, kind: "stale" });
  });

  it("records and accepts a pending-inquiry YES without booking the tour", async () => {
    const store = makeDb([event({ status: "pending", kind: "tour", smsConsent: true, phone: "+12065550100", proposedStart: start, proposedEnd: end, rescheduleNotificationGeneration: "inquiry-transition" })]);
    await expect(recordTourRescheduleSmsProposal(store.db, {
      managerUserId: "manager-1", inquiryId: "inquiry-1", phone: "+12065550100", start, end,
      generation: "inquiry-transition", recordId: TOUR_INQUIRIES_RECORD_ID,
    })).resolves.toBe(true);
    await expect(handleTourRescheduleSmsReply(store.db, {
      managerUserId: "manager-1", fromPhone: "+12065550100", toPhone: "+12065550999", body: "YES", messageSid: "SM-inquiry",
    })).resolves.toMatchObject({ handled: true, kind: "confirmed" });
    expect(store.inquiryRows()[0]).toMatchObject({ status: "pending" });
    expect(store.inquiryRows()[0]?.guestRescheduleReply).toMatchObject({ status: "confirmed", inboundMessageSid: "SM-inquiry" });
    await expect(handleTourRescheduleSmsReply(store.db, {
      managerUserId: "manager-1", fromPhone: "+12065550100", toPhone: "+12065550999", body: "YES", messageSid: "SM-inquiry",
    })).resolves.toMatchObject({ handled: true, kind: "duplicate" });
  });

  it("does not confirm either record when one planned tour and one inquiry await the same phone reply", async () => {
    const inquiryStart = "2026-09-13T18:00:00.000Z";
    const inquiryEnd = "2026-09-13T18:30:00.000Z";
    const inquiry = event({
      id: "inquiry-2",
      sourceInquiryId: undefined,
      status: "pending",
      kind: "tour",
      phone: "+12065550100",
      attendeePhone: undefined,
      proposedStart: inquiryStart,
      proposedEnd: inquiryEnd,
      rescheduleNotificationGeneration: "inquiry-transition",
    });
    const store = makeDb([event()], undefined, [inquiry]);
    await recordTourRescheduleSmsProposal(store.db, {
      managerUserId: "manager-1", inquiryId: "inquiry-1", phone: "+12065550100", start, end,
    });
    await recordTourRescheduleSmsProposal(store.db, {
      managerUserId: "manager-1", inquiryId: "inquiry-2", phone: "+12065550100",
      start: inquiryStart, end: inquiryEnd, generation: "inquiry-transition", recordId: TOUR_INQUIRIES_RECORD_ID,
    });

    await expect(handleTourRescheduleSmsReply(store.db, {
      managerUserId: "manager-1", fromPhone: "+12065550100", toPhone: "+12065550999", body: "YES", messageSid: "SM-mixed",
    })).resolves.toMatchObject({ handled: true, kind: "ambiguous" });
    expect(store.rows()[0]?.guestRescheduleReply).toMatchObject({ status: "awaiting_reply" });
    expect(store.inquiryRows()[0]?.guestRescheduleReply).toMatchObject({ status: "awaiting_reply" });
    expect(notifyManagerFromAgent).toHaveBeenCalledTimes(1);
  });

  it("fails closed for a stale or canceled proposal and ignores a wrong work number", async () => {
    const store = makeDb([event()]);
    await recordTourRescheduleSmsProposal(store.db, {
      managerUserId: "manager-1", inquiryId: "inquiry-1", phone: "+12065550100", start, end,
    });
    store.rows()[0]!.canceledAt = "2026-09-08T13:00:00.000Z";
    await expect(handleTourRescheduleSmsReply(store.db, {
      managerUserId: "manager-1", fromPhone: "+12065550100", toPhone: "+12065550999", body: "YES", messageSid: "SM-2",
    })).resolves.toMatchObject({ handled: true, kind: "stale" });
    await expect(handleTourRescheduleSmsReply(store.db, {
      managerUserId: "manager-1", fromPhone: "+12065550100", toPhone: "+12065550888", body: "YES", messageSid: "SM-3",
    })).resolves.toEqual({ handled: false });
  });

  it("routes an alternate time to manager follow-up and makes MessageSid replay idempotent", async () => {
    const store = makeDb([event()]);
    await recordTourRescheduleSmsProposal(store.db, {
      managerUserId: "manager-1", inquiryId: "inquiry-1", phone: "+12065550100", start, end,
    });
    const input = {
      managerUserId: "manager-1", fromPhone: "+12065550100", toPhone: "+12065550999",
      body: "Could we do Sunday at 2?", messageSid: "SM-4",
    };
    await expect(handleTourRescheduleSmsReply(store.db, input)).resolves.toMatchObject({ handled: true, kind: "follow_up" });
    expect(notifyManagerFromAgent).toHaveBeenCalledTimes(1);
    await expect(handleTourRescheduleSmsReply(store.db, input)).resolves.toMatchObject({ handled: true, kind: "duplicate" });
    expect(notifyManagerFromAgent).toHaveBeenCalledTimes(1);
  });

  it("lets ordinary leasing questions fall through after a terminal proposal", async () => {
    const store = makeDb([event()]);
    await recordTourRescheduleSmsProposal(store.db, {
      managerUserId: "manager-1", inquiryId: "inquiry-1", phone: "+12065550100", start, end,
    });
    await handleTourRescheduleSmsReply(store.db, {
      managerUserId: "manager-1", fromPhone: "+12065550100", toPhone: "+12065550999", body: "YES", messageSid: "SM-done",
    });
    await expect(handleTourRescheduleSmsReply(store.db, {
      managerUserId: "manager-1", fromPhone: "+12065550100", toPhone: "+12065550999", body: "What is the rent?", messageSid: "SM-question",
    })).resolves.toEqual({ handled: false });
  });

  it("lets an ordinary question fall through after a canceled proposal", async () => {
    const store = makeDb([event()]);
    await recordTourRescheduleSmsProposal(store.db, {
      managerUserId: "manager-1", inquiryId: "inquiry-1", phone: "+12065550100", start, end,
    });
    store.rows()[0]!.canceledAt = "2026-09-08T13:00:00.000Z";
    await expect(handleTourRescheduleSmsReply(store.db, {
      managerUserId: "manager-1", fromPhone: "+12065550100", toPhone: "+12065550999", body: "What is the rent?", messageSid: "SM-canceled-question",
    })).resolves.toEqual({ handled: false });
  });

  it("does not terminally consume an alternate reply until a manager notice is delivered", async () => {
    const store = makeDb([event()]);
    await recordTourRescheduleSmsProposal(store.db, {
      managerUserId: "manager-1", inquiryId: "inquiry-1", phone: "+12065550100", start, end,
    });
    notifyManagerFromAgent.mockResolvedValueOnce({ delivered: false, suppressed: true });
    const input = {
      managerUserId: "manager-1", fromPhone: "+12065550100", toPhone: "+12065550999",
      body: "Could we do Sunday at 2?", messageSid: "SM-suppressed",
    };
    await expect(handleTourRescheduleSmsReply(store.db, input)).resolves.toMatchObject({ handled: true, kind: "unavailable" });
    expect((store.rows()[0]?.guestRescheduleReply as { status: string }).status).toBe("awaiting_reply");
    await expect(handleTourRescheduleSmsReply(store.db, input)).resolves.toMatchObject({ handled: true, kind: "follow_up" });
    expect(notifyManagerFromAgent).toHaveBeenCalledTimes(2);
    expect(notifyManagerFromAgent.mock.calls[1]?.[1]).toMatchObject({ idempotencyKey: "tour-reschedule:SM-suppressed" });
  });

  it("keeps two concurrent YES replies when the clock is frozen", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-08T12:00:00.000Z"));
    try {
      const otherStart = "2026-09-13T18:00:00.000Z";
      const otherEnd = "2026-09-13T18:30:00.000Z";
      const store = makeDb([
        event(),
        event({ id: "tour-2", sourceInquiryId: "inquiry-2", attendeePhone: "+12065550101", start: otherStart, end: otherEnd }),
      ]);
      await recordTourRescheduleSmsProposal(store.db, {
        managerUserId: "manager-1", inquiryId: "inquiry-1", phone: "+12065550100", start, end,
      });
      await recordTourRescheduleSmsProposal(store.db, {
        managerUserId: "manager-1", inquiryId: "inquiry-2", phone: "+12065550101", start: otherStart, end: otherEnd,
      });
      const [first, second] = await Promise.all([
        handleTourRescheduleSmsReply(store.db, {
          managerUserId: "manager-1", fromPhone: "+12065550100", toPhone: "+12065550999", body: "YES", messageSid: "SM-concurrent-1",
        }),
        handleTourRescheduleSmsReply(store.db, {
          managerUserId: "manager-1", fromPhone: "+12065550101", toPhone: "+12065550999", body: "YES", messageSid: "SM-concurrent-2",
        }),
      ]);
      expect([first.kind, second.kind]).toEqual(["confirmed", "confirmed"]);
      expect(store.rows().map((row) => (row.guestRescheduleReply as { status: string }).status)).toEqual(["confirmed", "confirmed"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rechecks authorization and the exact window inside the CAS", async () => {
    const store = makeDb([event({ guestRescheduleReply: {
      version: `tour-1:${start}:${end}:+12065550100:+12065550999`, proposedStart: start, proposedEnd: end, requestedAt: start,
      status: "awaiting_reply", phoneE164: "+12065550100", workNumber: "+12065550999", conversationKey: "key",
    } })], (readCount, rows) => {
      if (readCount === 3) rows[0]!.start = "2026-09-13T18:00:00.000Z";
    });
    await expect(handleTourRescheduleSmsReply(store.db, {
      managerUserId: "manager-1", fromPhone: "+12065550100", toPhone: "+12065550999", body: "YES", messageSid: "SM-race",
    })).resolves.toMatchObject({ handled: true, kind: "stale" });
    expect((store.rows()[0]?.guestRescheduleReply as { status: string }).status).toBe("awaiting_reply");
  });

  it("does not mutate when more than one pending tour matches", async () => {
    const first = makeDb([event({ id: "tour-1" }), event({ id: "tour-2", sourceInquiryId: "inquiry-2" })]);
    await recordTourRescheduleSmsProposal(first.db, {
      managerUserId: "manager-1", inquiryId: "inquiry-1", phone: "+12065550100", start, end,
    });
    await recordTourRescheduleSmsProposal(first.db, {
      managerUserId: "manager-1", inquiryId: "inquiry-2", phone: "+12065550100", start, end,
    });
    await expect(handleTourRescheduleSmsReply(first.db, {
      managerUserId: "manager-1", fromPhone: "+12065550100", toPhone: "+12065550999", body: "YES", messageSid: "SM-5",
    })).resolves.toMatchObject({ handled: true, kind: "ambiguous" });
    expect(first.rows().map((row) => (row.guestRescheduleReply as { status: string }).status)).toEqual([
      "awaiting_reply", "awaiting_reply",
    ]);
    expect(notifyManagerFromAgent).toHaveBeenCalledTimes(1);
  });
});
