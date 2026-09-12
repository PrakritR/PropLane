import { beforeEach, describe, expect, it, vi } from "vitest";

const resolveActiveManagerSendNumber = vi.fn(async () => "+12065550999");
const notifyManagerFromAgent = vi.fn(async () => ({ delivered: true, suppressed: false }));
const resolveTourSmsEligibility = vi.fn(async () => ({
  eligible: true as const,
  phoneE164: "+12065550100",
  conversationKey: "manager-1:prospect:+12065550100",
  provenance: "tour_inquiry_opt_in" as const,
}));
vi.mock("@/lib/sms/manager-number-provisioning.server", () => ({
  resolveActiveManagerSendNumber: (...args: unknown[]) => resolveActiveManagerSendNumber(...(args as [])),
}));
vi.mock("@/lib/agent-notify.server", () => ({
  notifyManagerFromAgent: (...args: unknown[]) => notifyManagerFromAgent(...(args as [])),
}));
vi.mock("@/lib/sms/tour-sms-eligibility.server", () => ({
  resolveTourSmsEligibility: (...args: unknown[]) => resolveTourSmsEligibility(...(args as [])),
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

function makeDb(
  initialRows: Record<string, unknown>[],
  onRead?: (
    readCount: number,
    rows: Record<string, unknown>[],
    context: { recordId: string; advanceUpdatedAt: () => void },
  ) => void,
  inquiryRows = initialRows,
  options: { writeFailures?: number; failWriteAt?: number; afterWrite?: (rows: Record<string, unknown>[], writeCount: number) => void } = {},
) {
  const records = new Map([
    ["axis_admin_planned_events_v1", { rows: structuredClone(initialRows), updatedAt: "2026-09-08T12:00:00.000Z" }],
    [TOUR_INQUIRIES_RECORD_ID, { rows: structuredClone(inquiryRows), updatedAt: "2026-09-08T12:00:00.000Z" }],
  ]);
  let readCount = 0;
  let writeCount = 0;
  let attemptedWriteCount = 0;
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
            onRead?.(readCount, record.rows, {
              recordId: state.recordId ?? "axis_admin_planned_events_v1",
              advanceUpdatedAt: () => {
                record.updatedAt = new Date(Date.parse(record.updatedAt) + 1_000).toISOString();
              },
            });
            return { data: { row_data: { payload: structuredClone(record.rows) }, updated_at: record.updatedAt }, error: null };
          }
          if (state.expectedUpdatedAt !== record.updatedAt) return { data: null, error: null };
          attemptedWriteCount += 1;
          if (options.failWriteAt === attemptedWriteCount) return { data: null, error: null };
          if ((options.writeFailures ?? 0) > 0) {
            options.writeFailures = (options.writeFailures ?? 0) - 1;
            return { data: null, error: null };
          }
          record.rows = structuredClone(((state.update.row_data as { payload: Record<string, unknown>[] }).payload));
          record.updatedAt = String(state.update.updated_at);
          writeCount += 1;
          options.afterWrite?.(record.rows, writeCount);
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
    writeCount: () => writeCount,
    attemptedWriteCount: () => attemptedWriteCount,
    readCount: () => readCount,
  };
}

describe("tour reschedule SMS replies", () => {
  beforeEach(() => {
    resolveActiveManagerSendNumber.mockClear();
    notifyManagerFromAgent.mockClear();
    resolveTourSmsEligibility.mockClear();
    resolveTourSmsEligibility.mockResolvedValue({
      eligible: true,
      phoneE164: "+12065550100",
      conversationKey: "manager-1:prospect:+12065550100",
      provenance: "tour_inquiry_opt_in",
    });
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
      conversationKey: "manager-1:prospect:+12065550100",
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
    await expect(recordTourRescheduleSmsProposal(store.db, proposalInput)).resolves.toBe(false);
    expect((store.rows()[0]?.guestRescheduleReply as { status: string }).status).toBe("confirmed");
  });

  it("CAS-upgrades an eligible legacy proposal without changing its original sender or generation", async () => {
    const generation = "legacy-generation";
    const legacy = {
      version: `tour-1:${start}:${end}:+12065550100:${generation}`,
      generation,
      proposedStart: start,
      proposedEnd: end,
      requestedAt: start,
      status: "awaiting_reply" as const,
      phoneE164: "+12065550100",
      workNumber: "+12065550001",
      conversationKey: "legacy-key",
    };
    const store = makeDb([event({ rescheduleNotificationGeneration: generation, guestRescheduleReply: legacy })]);
    await expect(recordTourRescheduleSmsProposal(store.db, {
      managerUserId: "manager-1", inquiryId: "inquiry-1", phone: "+12065550100", start, end, generation,
    })).resolves.toBe(true);
    expect(store.rows()[0]?.guestRescheduleReply).toMatchObject({
      ...legacy, smsEligibility: "eligible", workNumber: "+12065550001", generation,
    });
  });

  it("accepts YES for an eligible legacy proposal without waiting for a notification retry", async () => {
    const generation = "legacy-inbound-generation";
    const store = makeDb([event({ rescheduleNotificationGeneration: generation, guestRescheduleReply: {
      version: `tour-1:${start}:${end}:+12065550100:${generation}`,
      generation, proposedStart: start, proposedEnd: end, requestedAt: start,
      status: "awaiting_reply", phoneE164: "+12065550100", workNumber: "+12065550999", conversationKey: "manager-1:prospect:+12065550100",
    } })]);
    await expect(handleTourRescheduleSmsReply(store.db, {
      managerUserId: "manager-1", fromPhone: "+12065550100", toPhone: "+12065550999", body: "YES", messageSid: "SM-legacy-direct",
    })).resolves.toMatchObject({ handled: true, kind: "confirmed" });
    expect(store.rows()[0]?.guestRescheduleReply).toMatchObject({ status: "confirmed", smsEligibility: "eligible" });
  });

  it("does not repair or reopen a terminal legacy proposal", async () => {
    const generation = "terminal-legacy-generation";
    const store = makeDb([event({ rescheduleNotificationGeneration: generation, guestRescheduleReply: {
      version: `tour-1:${start}:${end}:+12065550100:${generation}`,
      generation, proposedStart: start, proposedEnd: end, requestedAt: start,
      status: "confirmed", phoneE164: "+12065550100", workNumber: "+12065550001", conversationKey: "legacy-key",
    } })]);
    await expect(recordTourRescheduleSmsProposal(store.db, {
      managerUserId: "manager-1", inquiryId: "inquiry-1", phone: "+12065550100", start, end, generation,
    })).resolves.toBe(false);
    expect(store.rows()[0]?.guestRescheduleReply).toMatchObject({ status: "confirmed" });
    expect(store.rows()[0]?.guestRescheduleReply).not.toHaveProperty("smsEligibility");
  });

  it("rejects a legacy repair when the CAS reread has already replaced A with terminal B", async () => {
    const generationA = "generation-a";
    const generationB = "generation-b";
    const legacyA = {
      version: `tour-1:${start}:${end}:+12065550100:${generationA}`,
      generation: generationA,
      proposedStart: start,
      proposedEnd: end,
      requestedAt: start,
      status: "awaiting_reply" as const,
      phoneE164: "+12065550100",
      workNumber: "+12065550999",
      conversationKey: "manager-1:prospect:+12065550100",
    };
    const terminalB = {
      version: `tour-1:${start}:${end}:+12065550101:${generationB}`,
      generation: generationB,
      proposedStart: start,
      proposedEnd: end,
      requestedAt: end,
      status: "confirmed" as const,
      phoneE164: "+12065550101",
      workNumber: "+12065550888",
      conversationKey: "manager-1:prospect:+12065550101",
      smsEligibility: "eligible" as const,
      inboundMessageSid: "SM-b",
    };
    let contested = false;
    const store = makeDb([event({ guestRescheduleReply: legacyA, rescheduleNotificationGeneration: generationA })], (readCount, rows) => {
      if (readCount !== 3) return;
      contested = true;
      rows[0] = event({
        attendeePhone: "+12065550101",
        managerUserId: "manager-b",
        start: "2026-09-13T18:00:00.000Z",
        end: "2026-09-13T18:30:00.000Z",
        smsConsent: false,
        smsOrigin: "non_sms",
        rescheduleNotificationGeneration: generationB,
        guestRescheduleReply: terminalB,
      });
    });

    await expect(handleTourRescheduleSmsReply(store.db, {
      managerUserId: "manager-1", fromPhone: "+12065550100", toPhone: "+12065550999", body: "YES", messageSid: "SM-a",
    })).resolves.toMatchObject({ handled: true, kind: "stale" });
    expect(contested).toBe(true);
    expect(store.rows()[0]).toMatchObject({
      managerUserId: "manager-b",
      attendeePhone: "+12065550101",
      smsConsent: false,
      smsOrigin: "non_sms",
      rescheduleNotificationGeneration: generationB,
      guestRescheduleReply: terminalB,
    });
    expect(store.rows()[0]?.guestRescheduleReply).not.toMatchObject({ status: "awaiting_reply", generation: generationA });
  });

  it("keeps the original legacy snapshot across a failed CAS retry and rejects a changed second read", async () => {
    const generationA = "retry-generation-a";
    const generationB = "retry-generation-b";
    const legacyA = {
      version: `tour-1:${start}:${end}:+12065550100:${generationA}`,
      generation: generationA,
      proposedStart: start,
      proposedEnd: end,
      requestedAt: start,
      status: "awaiting_reply" as const,
      phoneE164: "+12065550100",
      workNumber: "+12065550999",
      conversationKey: "manager-1:prospect:+12065550100",
    };
    const terminalB = {
      version: `tour-1:${start}:${end}:+12065550101:${generationB}`,
      generation: generationB,
      proposedStart: start,
      proposedEnd: end,
      requestedAt: end,
      status: "confirmed" as const,
      phoneE164: "+12065550101",
      workNumber: "+12065550888",
      conversationKey: "manager-1:prospect:+12065550101",
      smsEligibility: "eligible" as const,
    };
    const store = makeDb([event({ guestRescheduleReply: legacyA, rescheduleNotificationGeneration: generationA })], (readCount, rows) => {
      if (readCount !== 4) return;
      rows[0] = event({
        managerUserId: "manager-b",
        attendeePhone: "+12065550101",
        start: "2026-09-13T18:00:00.000Z",
        end: "2026-09-13T18:30:00.000Z",
        smsConsent: false,
        smsOrigin: "non_sms",
        rescheduleNotificationGeneration: generationB,
        guestRescheduleReply: terminalB,
      });
    }, undefined, { writeFailures: 1 });

    await expect(handleTourRescheduleSmsReply(store.db, {
      managerUserId: "manager-1", fromPhone: "+12065550100", toPhone: "+12065550999", body: "YES", messageSid: "SM-retry",
    })).resolves.toMatchObject({ handled: true, kind: "stale" });
    expect(store.rows()[0]).toMatchObject({
      managerUserId: "manager-b",
      attendeePhone: "+12065550101",
      smsOrigin: "non_sms",
      rescheduleNotificationGeneration: generationB,
      guestRescheduleReply: terminalB,
    });
  });

  it("rejects a late generation-A recorder when the row is already generation B", async () => {
    const generationB = "current-generation-b";
    const current = event({
      rescheduleNotificationGeneration: generationB,
      guestRescheduleReply: {
        version: `tour-1:${start}:${end}:+12065550100:${generationB}`,
        generation: generationB,
        proposedStart: start,
        proposedEnd: end,
        requestedAt: end,
        status: "awaiting_reply",
        phoneE164: "+12065550100",
        workNumber: "+12065550999",
        conversationKey: "current-key",
        smsEligibility: "eligible",
      },
    });
    const store = makeDb([current]);
    await expect(recordTourRescheduleSmsProposal(store.db, {
      managerUserId: "manager-1", inquiryId: "inquiry-1", phone: "+12065550100", start, end, generation: "generation-a",
    })).resolves.toBe(false);
    expect(store.rows()[0]?.guestRescheduleReply).toMatchObject({ generation: generationB, status: "awaiting_reply", conversationKey: "current-key" });
  });

  it("does not confirm newer eligible B after legacy A repair succeeds", async () => {
    const generationA = "repair-generation-a";
    const generationB = "repair-generation-b";
    const legacyA = {
      version: `tour-1:${start}:${end}:+12065550100:${generationA}`,
      generation: generationA,
      proposedStart: start,
      proposedEnd: end,
      requestedAt: start,
      status: "awaiting_reply" as const,
      phoneE164: "+12065550100",
      workNumber: "+12065550999",
      conversationKey: "manager-1:prospect:+12065550100",
    };
    const newerB = {
      version: `tour-1:${start}:${end}:+12065550100:${generationB}`,
      generation: generationB,
      proposedStart: start,
      proposedEnd: end,
      requestedAt: end,
      status: "awaiting_reply" as const,
      phoneE164: "+12065550100",
      workNumber: "+12065550999",
      conversationKey: "manager-1:prospect:+12065550100",
      smsEligibility: "eligible" as const,
    };
    const store = makeDb(
      [event({ rescheduleNotificationGeneration: generationA, guestRescheduleReply: legacyA })],
      undefined,
      undefined,
      {
        afterWrite: (rows, writeCount) => {
          if (writeCount !== 1) return;
          rows[0] = event({ rescheduleNotificationGeneration: generationB, guestRescheduleReply: newerB });
        },
      },
    );

    await expect(handleTourRescheduleSmsReply(store.db, {
      managerUserId: "manager-1", fromPhone: "+12065550100", toPhone: "+12065550999", body: "YES", messageSid: "SM-reread-b",
    })).resolves.toMatchObject({ handled: true, kind: "stale" });
    expect(store.writeCount()).toBe(1);
    expect(store.rows()[0]?.guestRescheduleReply).toMatchObject({ generation: generationB, status: "awaiting_reply" });
    expect(store.rows()[0]?.guestRescheduleReply).not.toHaveProperty("inboundMessageSid");
  });

  it.each(["smsOrigin", "smsConsent", "sourceInquiryId", "conversationKey", "requestedAt"] as const)(
    "keeps the planned legacy snapshot through final CAS when %s changes after the guarded reread",
    async (field) => {
      let contestedReadReached = false;
      const generation = `planned-final-${field}`;
      const legacy = {
        version: `tour-1:${start}:${end}:+12065550100:${generation}`,
        generation,
        proposedStart: start,
        proposedEnd: end,
        requestedAt: start,
        status: "awaiting_reply" as const,
        phoneE164: "+12065550100",
        workNumber: "+12065550999",
        conversationKey: "manager-1:prospect:+12065550100",
      };
      const store = makeDb([event({
        rescheduleNotificationGeneration: generation,
        guestRescheduleReply: legacy,
      })], (readCount, rows, context) => {
        if (readCount !== 6) return;
        contestedReadReached = true;
        context.advanceUpdatedAt();
        if (field === "sourceInquiryId") rows[0]!.sourceInquiryId = "changed-inquiry";
        else if (field === "smsOrigin") rows[0]!.smsOrigin = "non_sms";
        else if (field === "smsConsent") rows[0]!.smsConsent = false;
        else (rows[0]!.guestRescheduleReply as Record<string, unknown>)[field] = "changed";
      });

      await expect(handleTourRescheduleSmsReply(store.db, {
        managerUserId: "manager-1", fromPhone: "+12065550100", toPhone: "+12065550999",
        body: "YES", messageSid: `SM-planned-final-${field}`,
      })).resolves.toMatchObject({ handled: true, kind: "stale" });
      expect(contestedReadReached).toBe(true);
      expect(store.writeCount()).toBe(1);
      expect(store.rows()[0]?.guestRescheduleReply).toMatchObject({
        status: "awaiting_reply",
      });
      expect(store.rows()[0]?.guestRescheduleReply).not.toHaveProperty("inboundMessageSid");
    },
  );

  it("keeps the planned legacy snapshot through an alternate-time final CAS", async () => {
    let contestedReadReached = false;
    const generation = "planned-alternate-final";
    const legacy = {
      version: `tour-1:${start}:${end}:+12065550100:${generation}`,
      generation,
      proposedStart: start,
      proposedEnd: end,
      requestedAt: start,
      status: "awaiting_reply" as const,
      phoneE164: "+12065550100",
      workNumber: "+12065550999",
      conversationKey: "manager-1:prospect:+12065550100",
    };
    const store = makeDb([event({
      rescheduleNotificationGeneration: generation,
      guestRescheduleReply: legacy,
    })], (readCount, rows, context) => {
      if (readCount === 6) {
        contestedReadReached = true;
        context.advanceUpdatedAt();
        rows[0]!.smsOrigin = "non_sms";
      }
    });

    await expect(handleTourRescheduleSmsReply(store.db, {
      managerUserId: "manager-1", fromPhone: "+12065550100", toPhone: "+12065550999",
      body: "Could we do Sunday at 2?", messageSid: "SM-planned-alternate-final",
    })).resolves.toMatchObject({ handled: true, kind: "stale" });
    expect(contestedReadReached).toBe(true);
    expect(store.writeCount()).toBe(1);
    expect(store.rows()[0]?.guestRescheduleReply).toMatchObject({ status: "awaiting_reply" });
    expect(notifyManagerFromAgent).toHaveBeenCalledTimes(1);
  });

  it.each(["smsOrigin", "smsConsent", "sourceInquiryId", "conversationKey", "requestedAt"] as const)(
    "keeps the pending legacy snapshot through final CAS when %s changes after the guarded reread",
    async (field) => {
      let contestedReadReached = false;
      const generation = `pending-final-${field}`;
      const inquiry = event({
        id: "pending-legacy",
        sourceInquiryId: "pending-source",
        status: "pending",
        kind: "tour",
        phone: "+12065550100",
        attendeePhone: undefined,
        proposedStart: start,
        proposedEnd: end,
        rescheduleNotificationGeneration: generation,
        guestRescheduleReply: {
          version: `pending-legacy:${start}:${end}:+12065550100:${generation}`,
          generation,
          proposedStart: start,
          proposedEnd: end,
          requestedAt: start,
          status: "awaiting_reply" as const,
          phoneE164: "+12065550100",
          workNumber: "+12065550999",
          conversationKey: "manager-1:prospect:+12065550100",
        },
      });
      const store = makeDb([event({ id: "unrelated-planned" })], (readCount, rows, context) => {
        if (readCount !== 6) return;
        contestedReadReached = true;
        context.advanceUpdatedAt();
        if (field === "sourceInquiryId") rows[0]!.sourceInquiryId = "changed-inquiry";
        else if (field === "smsOrigin") rows[0]!.smsOrigin = "non_sms";
        else if (field === "smsConsent") rows[0]!.smsConsent = false;
        else (rows[0]!.guestRescheduleReply as Record<string, unknown>)[field] = "changed";
      }, [inquiry]);

      await expect(handleTourRescheduleSmsReply(store.db, {
        managerUserId: "manager-1", fromPhone: "+12065550100", toPhone: "+12065550999",
        body: "YES", messageSid: `SM-pending-final-${field}`,
      })).resolves.toMatchObject({ handled: true, kind: "stale" });
      expect(contestedReadReached).toBe(true);
      expect(store.writeCount()).toBe(1);
      expect(store.inquiryRows()[0]?.guestRescheduleReply).toMatchObject({ status: "awaiting_reply" });
      expect(store.inquiryRows()[0]?.guestRescheduleReply).not.toHaveProperty("inboundMessageSid");
    },
  );

  it("counts two actionable legacy proposals with one modern proposal before selecting a singleton", async () => {
    const modern = event({
      id: "modern-planned",
      sourceInquiryId: "modern-source",
      propertyTitle: "Modern House",
      guestRescheduleReply: {
        version: `modern-planned:${start}:${end}:+12065550100:+12065550999`,
        proposedStart: start,
        proposedEnd: end,
        requestedAt: start,
        status: "awaiting_reply" as const,
        phoneE164: "+12065550100",
        workNumber: "+12065550999",
        conversationKey: "modern-key",
        smsEligibility: "eligible" as const,
      },
    });
    const legacyRows = ["legacy-one", "legacy-two"].map((id, index) => event({
      id,
      sourceInquiryId: `${id}-source`,
      status: "pending",
      kind: "tour",
      phone: "+12065550100",
      attendeePhone: undefined,
      proposedStart: `2026-09-${13 + index}T18:00:00.000Z`,
      proposedEnd: `2026-09-${13 + index}T18:30:00.000Z`,
      rescheduleNotificationGeneration: `${id}-generation`,
      guestRescheduleReply: {
        version: `${id}:${`2026-09-${13 + index}T18:00:00.000Z`}:${`2026-09-${13 + index}T18:30:00.000Z`}: +12065550100:${id}-generation`.replace(": ", ":"),
        generation: `${id}-generation`,
        proposedStart: `2026-09-${13 + index}T18:00:00.000Z`,
        proposedEnd: `2026-09-${13 + index}T18:30:00.000Z`,
        requestedAt: start,
        status: "awaiting_reply" as const,
        phoneE164: "+12065550100",
        workNumber: "+12065550999",
        conversationKey: "manager-1:prospect:+12065550100",
      },
    }));
    const store = makeDb([modern], undefined, legacyRows);

    await expect(handleTourRescheduleSmsReply(store.db, {
      managerUserId: "manager-1", fromPhone: "+12065550100", toPhone: "+12065550999",
      body: "YES", messageSid: "SM-mixed-legacy-modern",
    })).resolves.toMatchObject({ handled: true, kind: "ambiguous" });
    expect(store.rows()[0]?.guestRescheduleReply).toMatchObject({ status: "awaiting_reply" });
    expect(store.inquiryRows().map((row) => (row.guestRescheduleReply as { status: string }).status)).toEqual([
      "awaiting_reply", "awaiting_reply",
    ]);
  });

  it("does not confirm a modern proposal when a scoped legacy candidate is unreadable", async () => {
    const modern = event({
      id: "modern-with-unreadable-legacy",
      guestRescheduleReply: {
        version: `modern-with-unreadable-legacy:${start}:${end}:+12065550100:+12065550999`,
        proposedStart: start,
        proposedEnd: end,
        requestedAt: start,
        status: "awaiting_reply" as const,
        phoneE164: "+12065550100",
        workNumber: "+12065550999",
        conversationKey: "modern-key",
        smsEligibility: "eligible" as const,
      },
    });
    const legacy = event({
      id: "unreadable-legacy",
      status: "pending",
      kind: "tour",
      phone: "+12065550100",
      attendeePhone: undefined,
      proposedStart: "2026-09-13T18:00:00.000Z",
      proposedEnd: "2026-09-13T18:30:00.000Z",
      rescheduleNotificationGeneration: "unreadable-generation",
      guestRescheduleReply: {
        version: "unreadable-legacy:2026-09-13T18:00:00.000Z:2026-09-13T18:30:00.000Z:+12065550100:unreadable-generation",
        generation: "unreadable-generation",
        proposedStart: "2026-09-13T18:00:00.000Z",
        proposedEnd: "2026-09-13T18:30:00.000Z",
        requestedAt: start,
        status: "awaiting_reply" as const,
        phoneE164: "+12065550100",
        workNumber: "+12065550999",
        conversationKey: "manager-1:prospect:+12065550100",
      },
    });
    const store = makeDb([modern], undefined, [legacy]);
    resolveTourSmsEligibility.mockResolvedValueOnce({ eligible: false, reason: "conversation_consent_unreadable" });

    await expect(handleTourRescheduleSmsReply(store.db, {
      managerUserId: "manager-1", fromPhone: "+12065550100", toPhone: "+12065550999",
      body: "YES", messageSid: "SM-unreadable-legacy",
    })).resolves.toMatchObject({ handled: true, kind: "ambiguous" });
    expect(store.rows()[0]?.guestRescheduleReply).toMatchObject({ status: "awaiting_reply" });
    expect(store.inquiryRows()[0]?.guestRescheduleReply).toMatchObject({ status: "awaiting_reply" });
  });

  it("fails closed when a legacy conversation key does not match the resolved authority", async () => {
    const modern = event({
      id: "modern-mismatch",
      guestRescheduleReply: {
        version: `modern-mismatch:${start}:${end}:+12065550100:+12065550999`,
        proposedStart: start, proposedEnd: end, requestedAt: start, status: "awaiting_reply" as const,
        phoneE164: "+12065550100", workNumber: "+12065550999", conversationKey: "modern-key", smsEligibility: "eligible" as const,
      },
    });
    const legacy = event({
      id: "legacy-mismatch", status: "pending", kind: "tour", phone: "+12065550100", attendeePhone: undefined,
      proposedStart: "2026-09-13T18:00:00.000Z", proposedEnd: "2026-09-13T18:30:00.000Z",
      rescheduleNotificationGeneration: "legacy-mismatch-generation",
      guestRescheduleReply: {
        version: "legacy-mismatch:2026-09-13T18:00:00.000Z:2026-09-13T18:30:00.000Z:+12065550100:legacy-mismatch-generation",
        generation: "legacy-mismatch-generation", proposedStart: "2026-09-13T18:00:00.000Z", proposedEnd: "2026-09-13T18:30:00.000Z",
        requestedAt: start, status: "awaiting_reply" as const, phoneE164: "+12065550100", workNumber: "+12065550999",
        conversationKey: "stale-conversation-key",
      },
    });
    const store = makeDb([modern], undefined, [legacy]);
    await expect(handleTourRescheduleSmsReply(store.db, {
      managerUserId: "manager-1", fromPhone: "+12065550100", toPhone: "+12065550999", body: "YES", messageSid: "SM-mismatch",
    })).resolves.toMatchObject({ handled: true, kind: expect.not.stringMatching(/^confirmed$/) });
    expect(store.rows()[0]?.guestRescheduleReply).toMatchObject({ status: "awaiting_reply" });
    expect(store.inquiryRows()[0]?.guestRescheduleReply).toMatchObject({ status: "awaiting_reply" });
  });

  it.each([
    { label: "planned YES", inquiry: false, body: "YES" },
    { label: "planned alternate", inquiry: false, body: "Could we do Sunday at 2?" },
    { label: "pending YES", inquiry: true, body: "YES" },
  ])("retains the legacy snapshot and competitor after a failed final-CAS retry ($label)", async ({ inquiry, body }) => {
    let contestedReadReached = false;
    const generation = `retry-final-${inquiry ? "pending" : "planned"}`;
    const target = event({
      id: inquiry ? "pending-retry-final" : "planned-retry-final",
      sourceInquiryId: inquiry ? "pending-retry-final-source" : "planned-retry-final-source",
      ...(inquiry ? {
        status: "pending", kind: "tour", phone: "+12065550100", attendeePhone: undefined,
        proposedStart: start, proposedEnd: end,
      } : {}),
      rescheduleNotificationGeneration: generation,
      guestRescheduleReply: {
        version: `${inquiry ? "pending-retry-final" : "planned-retry-final"}:${start}:${end}:+12065550100:${generation}`,
        generation, proposedStart: start, proposedEnd: end, requestedAt: start, status: "awaiting_reply" as const,
        phoneE164: "+12065550100", workNumber: "+12065550999", conversationKey: "manager-1:prospect:+12065550100",
      },
    });
    const omittedField = inquiry ? "conversationKey" : body === "YES" ? "smsOrigin" : "sourceInquiryId";
    let competitor: Record<string, unknown> | null = null;
    const store = makeDb(
      inquiry ? [event({ id: "unrelated-planned" })] : [target],
      (readCount, rows, context) => {
        if (readCount !== 7) return;
        contestedReadReached = true;
        context.advanceUpdatedAt();
        competitor = structuredClone(rows[0]!);
        if (omittedField === "conversationKey") {
          (competitor.guestRescheduleReply as Record<string, unknown>).conversationKey = "competitor-conversation";
        } else {
          competitor[omittedField] = omittedField === "smsOrigin" ? "non_sms" : "competitor-source";
        }
        rows[0] = competitor;
      },
      inquiry ? [target] : undefined,
      { failWriteAt: 2 },
    );
    const result = await handleTourRescheduleSmsReply(store.db, {
      managerUserId: "manager-1", fromPhone: "+12065550100", toPhone: "+12065550999", body, messageSid: `SM-${generation}`,
    });
    expect(result).toMatchObject({ handled: true, kind: "stale" });
    expect(contestedReadReached).toBe(true);
    expect(store.writeCount()).toBe(1);
    expect(store.attemptedWriteCount()).toBe(2);
    const retained = inquiry ? store.inquiryRows()[0] : store.rows()[0];
    expect(competitor).not.toBeNull();
    expect(retained).toEqual(competitor);
    expect(retained?.guestRescheduleReply).toMatchObject({ status: "awaiting_reply" });
    expect(retained?.guestRescheduleReply).not.toHaveProperty("inboundMessageSid");
  });

  it("treats one eligible legacy and one modern proposal as ambiguous", async () => {
    const modern = event({ id: "modern-one", guestRescheduleReply: {
      version: `modern-one:${start}:${end}:+12065550100:+12065550999`, proposedStart: start, proposedEnd: end,
      requestedAt: start, status: "awaiting_reply" as const, phoneE164: "+12065550100", workNumber: "+12065550999",
      conversationKey: "modern-key", smsEligibility: "eligible" as const,
    } });
    const legacy = event({ id: "legacy-one", status: "pending", kind: "tour", phone: "+12065550100", attendeePhone: undefined,
      proposedStart: "2026-09-13T18:00:00.000Z", proposedEnd: "2026-09-13T18:30:00.000Z", rescheduleNotificationGeneration: "legacy-one-generation",
      guestRescheduleReply: {
        version: "legacy-one:2026-09-13T18:00:00.000Z:2026-09-13T18:30:00.000Z:+12065550100:legacy-one-generation", generation: "legacy-one-generation",
        proposedStart: "2026-09-13T18:00:00.000Z", proposedEnd: "2026-09-13T18:30:00.000Z", requestedAt: start, status: "awaiting_reply" as const,
        phoneE164: "+12065550100", workNumber: "+12065550999", conversationKey: "manager-1:prospect:+12065550100",
      } });
    const store = makeDb([modern], undefined, [legacy]);
    await expect(handleTourRescheduleSmsReply(store.db, {
      managerUserId: "manager-1", fromPhone: "+12065550100", toPhone: "+12065550999", body: "YES", messageSid: "SM-one-legacy-modern",
    })).resolves.toMatchObject({ handled: true, kind: "ambiguous" });
    expect(store.rows()[0]?.guestRescheduleReply).toMatchObject({ status: "awaiting_reply" });
    expect(store.inquiryRows()[0]?.guestRescheduleReply).toMatchObject({ status: "awaiting_reply" });
  });

  it("does not let a definitively ineligible legacy candidate block a unique modern proposal", async () => {
    const modern = event({ id: "modern-ineligible-legacy", guestRescheduleReply: {
      version: `modern-ineligible-legacy:${start}:${end}:+12065550100:+12065550999`, proposedStart: start, proposedEnd: end,
      requestedAt: start, status: "awaiting_reply" as const, phoneE164: "+12065550100", workNumber: "+12065550999",
      conversationKey: "modern-key", smsEligibility: "eligible" as const,
    } });
    const legacy = event({ id: "definitively-ineligible", status: "pending", kind: "tour", phone: "+12065550100", attendeePhone: undefined,
      proposedStart: "2026-09-13T18:00:00.000Z", proposedEnd: "2026-09-13T18:30:00.000Z", rescheduleNotificationGeneration: "ineligible-generation",
      guestRescheduleReply: {
        version: "definitively-ineligible:2026-09-13T18:00:00.000Z:2026-09-13T18:30:00.000Z:+12065550100:ineligible-generation", generation: "ineligible-generation",
        proposedStart: "2026-09-13T18:00:00.000Z", proposedEnd: "2026-09-13T18:30:00.000Z", requestedAt: start, status: "awaiting_reply" as const,
        phoneE164: "+12065550100", workNumber: "+12065550999", conversationKey: "manager-1:prospect:+12065550100",
      } });
    const store = makeDb([modern], undefined, [legacy]);
    resolveTourSmsEligibility.mockResolvedValueOnce({ eligible: false, reason: "recipient_opted_out" });
    await expect(handleTourRescheduleSmsReply(store.db, {
      managerUserId: "manager-1", fromPhone: "+12065550100", toPhone: "+12065550999", body: "YES", messageSid: "SM-ineligible-legacy",
    })).resolves.toMatchObject({ handled: true, kind: "confirmed" });
    expect(store.rows()[0]?.guestRescheduleReply).toMatchObject({ status: "confirmed", inboundMessageSid: "SM-ineligible-legacy" });
    expect(store.inquiryRows()[0]?.guestRescheduleReply).toMatchObject({ status: "awaiting_reply" });
  });

  it("does not consume a same-id candidate from the other inventory after legacy repair", async () => {
    let plannedRetiredAfterRepair = false;
    let pendingActivatedAfterRepair = false;
    const sharedId = "cross-record-shared-id";
    const generation = "cross-record-generation";
    const legacy = event({ id: sharedId, rescheduleNotificationGeneration: generation, guestRescheduleReply: {
      version: `${sharedId}:${start}:${end}:+12065550100:${generation}`, generation, proposedStart: start, proposedEnd: end,
      requestedAt: start, status: "awaiting_reply" as const, phoneE164: "+12065550100", workNumber: "+12065550999",
      conversationKey: "manager-1:prospect:+12065550100",
    } });
    const otherInventory = event({ id: sharedId, status: "closed", kind: "tour", phone: "+12065550100", attendeePhone: undefined,
      proposedStart: start, proposedEnd: end, rescheduleNotificationGeneration: generation,
      guestRescheduleReply: {
        version: `${sharedId}:${start}:${end}:+12065550100:${generation}`, generation, proposedStart: start, proposedEnd: end,
        requestedAt: start, status: "awaiting_reply" as const, phoneE164: "+12065550100", workNumber: "+12065550999",
        conversationKey: "manager-1:prospect:+12065550100", smsEligibility: "eligible" as const,
      } });
    const store = makeDb([legacy], (readCount, rows, context) => {
      if (readCount === 4 && context.recordId === "axis_admin_planned_events_v1") {
        plannedRetiredAfterRepair = true;
        rows[0]!.canceledAt = "2026-09-10T12:00:00.000Z";
      }
      if (readCount === 5 && context.recordId === TOUR_INQUIRIES_RECORD_ID) {
        pendingActivatedAfterRepair = true;
        rows[0]!.status = "pending";
      }
    }, [otherInventory]);
    await expect(handleTourRescheduleSmsReply(store.db, {
      managerUserId: "manager-1", fromPhone: "+12065550100", toPhone: "+12065550999", body: "YES", messageSid: "SM-cross-record",
    })).resolves.toMatchObject({ handled: true, kind: "stale" });
    expect(plannedRetiredAfterRepair).toBe(true);
    expect(pendingActivatedAfterRepair).toBe(true);
    expect(store.writeCount()).toBe(1);
    expect(store.rows()[0]).toMatchObject({ id: sharedId, canceledAt: "2026-09-10T12:00:00.000Z" });
    expect(store.rows()[0]?.guestRescheduleReply).toMatchObject({ status: "awaiting_reply", smsEligibility: "eligible" });
    expect(store.inquiryRows()[0]?.guestRescheduleReply).toMatchObject({ status: "awaiting_reply" });
  });

  it("routes legacy-only ambiguity to manager follow-up without repairing either proposal", async () => {
    const legacyRows = ["legacy-only-a", "legacy-only-b"].map((id, index) => event({
      id, sourceInquiryId: `${id}-source`, status: "pending", kind: "tour", phone: "+12065550100", attendeePhone: undefined,
      proposedStart: `2026-09-${13 + index}T18:00:00.000Z`, proposedEnd: `2026-09-${13 + index}T18:30:00.000Z`,
      rescheduleNotificationGeneration: `${id}-generation`, guestRescheduleReply: {
        version: `${id}:2026-09-${13 + index}T18:00:00.000Z:2026-09-${13 + index}T18:30:00.000Z:+12065550100:${id}-generation`,
        generation: `${id}-generation`, proposedStart: `2026-09-${13 + index}T18:00:00.000Z`, proposedEnd: `2026-09-${13 + index}T18:30:00.000Z`,
        requestedAt: start, status: "awaiting_reply" as const, phoneE164: "+12065550100", workNumber: "+12065550999",
        conversationKey: "manager-1:prospect:+12065550100",
      },
    }));
    const store = makeDb([], undefined, legacyRows);
    await expect(handleTourRescheduleSmsReply(store.db, {
      managerUserId: "manager-1", fromPhone: "+12065550100", toPhone: "+12065550999", body: "YES", messageSid: "SM-legacy-only",
    })).resolves.toMatchObject({ handled: true, kind: "ambiguous" });
    expect(store.inquiryRows().map((row) => (row.guestRescheduleReply as { status: string }).status)).toEqual([
      "awaiting_reply", "awaiting_reply",
    ]);
  });

  it("detects ambiguity across a planned and pending legacy/modern inventory", async () => {
    const planned = event({ id: "planned-modern-mixed", guestRescheduleReply: {
      version: `planned-modern-mixed:${start}:${end}:+12065550100:+12065550999`, proposedStart: start, proposedEnd: end,
      requestedAt: start, status: "awaiting_reply" as const, phoneE164: "+12065550100", workNumber: "+12065550999",
      conversationKey: "modern-key", smsEligibility: "eligible" as const,
    } });
    const pending = event({ id: "pending-legacy-mixed", status: "pending", kind: "tour", phone: "+12065550100", attendeePhone: undefined,
      proposedStart: "2026-09-13T18:00:00.000Z", proposedEnd: "2026-09-13T18:30:00.000Z", rescheduleNotificationGeneration: "pending-legacy-mixed-generation",
      guestRescheduleReply: {
        version: "pending-legacy-mixed:2026-09-13T18:00:00.000Z:2026-09-13T18:30:00.000Z:+12065550100:pending-legacy-mixed-generation", generation: "pending-legacy-mixed-generation",
        proposedStart: "2026-09-13T18:00:00.000Z", proposedEnd: "2026-09-13T18:30:00.000Z", requestedAt: start,
        status: "awaiting_reply" as const, phoneE164: "+12065550100", workNumber: "+12065550999", conversationKey: "manager-1:prospect:+12065550100",
      },
    });
    const store = makeDb([planned], undefined, [pending]);
    await expect(handleTourRescheduleSmsReply(store.db, {
      managerUserId: "manager-1", fromPhone: "+12065550100", toPhone: "+12065550999", body: "YES", messageSid: "SM-mixed-planned-pending",
    })).resolves.toMatchObject({ handled: true, kind: "ambiguous" });
    expect(store.rows()[0]?.guestRescheduleReply).toMatchObject({ status: "awaiting_reply" });
    expect(store.inquiryRows()[0]?.guestRescheduleReply).toMatchObject({ status: "awaiting_reply" });
  });

  it("accepts generationless planned and pending legacy proposals", async () => {
    const planned = event({ guestRescheduleReply: {
      version: `tour-1:${start}:${end}:+12065550100:+12065550999`, proposedStart: start, proposedEnd: end,
      requestedAt: start, status: "awaiting_reply" as const, phoneE164: "+12065550100", workNumber: "+12065550999",
      conversationKey: "manager-1:prospect:+12065550100",
    } });
    const pending = event({ id: "generationless-pending", status: "pending", kind: "tour", phone: "+12065550100", attendeePhone: undefined,
      proposedStart: "2026-09-13T18:00:00.000Z", proposedEnd: "2026-09-13T18:30:00.000Z",
      guestRescheduleReply: {
        version: "generationless-pending:2026-09-13T18:00:00.000Z:2026-09-13T18:30:00.000Z:+12065550100:+12065550999", proposedStart: "2026-09-13T18:00:00.000Z", proposedEnd: "2026-09-13T18:30:00.000Z",
        requestedAt: start, status: "awaiting_reply" as const, phoneE164: "+12065550100", workNumber: "+12065550999", conversationKey: "manager-1:prospect:+12065550100",
      },
    });
    const plannedStore = makeDb([planned]);
    await expect(handleTourRescheduleSmsReply(plannedStore.db, {
      managerUserId: "manager-1", fromPhone: "+12065550100", toPhone: "+12065550999", body: "YES", messageSid: "SM-generationless-planned",
    })).resolves.toMatchObject({ handled: true, kind: "confirmed" });
    const pendingStore = makeDb([], undefined, [pending]);
    await expect(handleTourRescheduleSmsReply(pendingStore.db, {
      managerUserId: "manager-1", fromPhone: "+12065550100", toPhone: "+12065550999", body: "YES", messageSid: "SM-generationless-pending",
    })).resolves.toMatchObject({ handled: true, kind: "confirmed" });
  });

  it("excludes foreign, wrong-contact, canceled, terminal, obsolete-generation and invalid-window candidates", async () => {
    const valid = event({ id: "valid-exclusion-control", guestRescheduleReply: {
      version: `valid-exclusion-control:${start}:${end}:+12065550100:+12065550999`, proposedStart: start, proposedEnd: end,
      requestedAt: start, status: "awaiting_reply" as const, phoneE164: "+12065550100", workNumber: "+12065550999",
      conversationKey: "valid-key", smsEligibility: "eligible" as const,
    } });
    const base = (id: string, overrides: Record<string, unknown>) => event({ id, guestRescheduleReply: {
      version: `${id}:${start}:${end}:+12065550100:+12065550999`, proposedStart: start, proposedEnd: end, requestedAt: start,
      status: "awaiting_reply" as const, phoneE164: "+12065550100", workNumber: "+12065550999", conversationKey: "excluded-key", smsEligibility: "eligible" as const,
    }, ...overrides });
    const rows = [
      base("foreign-owner", { managerUserId: "manager-foreign" }),
      base("wrong-guest", { attendeePhone: "+12065550101" }),
      base("wrong-work", { guestRescheduleReply: { ...(base("wrong-work-inner").guestRescheduleReply as Record<string, unknown>), workNumber: "+12065550888" } }),
      base("canceled", { canceledAt: "2026-09-08T13:00:00.000Z" }),
      base("terminal", { guestRescheduleReply: { ...(base("terminal-inner").guestRescheduleReply as Record<string, unknown>), status: "confirmed" } }),
      base("obsolete-generation", { rescheduleNotificationGeneration: "new-generation" }),
      base("invalid-window", { start: "2026-09-13T18:00:00.000Z", end: "2026-09-13T18:30:00.000Z" }),
      valid,
    ];
    const store = makeDb(rows);
    await expect(handleTourRescheduleSmsReply(store.db, {
      managerUserId: "manager-1", fromPhone: "+12065550100", toPhone: "+12065550999", body: "YES", messageSid: "SM-exclusions",
    })).resolves.toMatchObject({ handled: true, kind: "confirmed" });
    expect(store.rows().find((row) => row.id === "valid-exclusion-control")?.guestRescheduleReply).toMatchObject({ status: "confirmed" });
    expect(store.rows().filter((row) => row.id !== "valid-exclusion-control").map((row) => [row.id, (row.guestRescheduleReply as { status: string }).status])).toEqual([
      ["foreign-owner", "awaiting_reply"], ["wrong-guest", "awaiting_reply"], ["wrong-work", "awaiting_reply"],
      ["canceled", "awaiting_reply"], ["terminal", "confirmed"], ["obsolete-generation", "awaiting_reply"], ["invalid-window", "awaiting_reply"],
    ]);
  });

  it("does not consume a repaired legacy alternate reply when manager notification fails", async () => {
    const generation = "legacy-notice-failure";
    const legacy = event({ rescheduleNotificationGeneration: generation, guestRescheduleReply: {
      version: `tour-1:${start}:${end}:+12065550100:${generation}`, generation, proposedStart: start, proposedEnd: end, requestedAt: start,
      status: "awaiting_reply" as const, phoneE164: "+12065550100", workNumber: "+12065550999", conversationKey: "manager-1:prospect:+12065550100",
    } });
    const store = makeDb([legacy]);
    notifyManagerFromAgent.mockResolvedValueOnce({ delivered: false, suppressed: true });
    await expect(handleTourRescheduleSmsReply(store.db, {
      managerUserId: "manager-1", fromPhone: "+12065550100", toPhone: "+12065550999", body: "Could we do Sunday at 2?", messageSid: "SM-legacy-notice-failure",
    })).resolves.toMatchObject({ handled: true, kind: "unavailable" });
    expect(store.rows()[0]?.guestRescheduleReply).toMatchObject({ status: "awaiting_reply", smsEligibility: "eligible" });
    expect(store.rows()[0]?.guestRescheduleReply).not.toHaveProperty("inboundMessageSid");
  });

  it("bounds repeated legacy repair recursion after CAS success", async () => {
    const generationA = "bounded-generation-a";
    const legacyA = {
      version: `tour-1:${start}:${end}:+12065550100:${generationA}`,
      generation: generationA,
      proposedStart: start,
      proposedEnd: end,
      requestedAt: start,
      status: "awaiting_reply" as const,
      phoneE164: "+12065550100",
      workNumber: "+12065550999",
      conversationKey: "manager-1:prospect:+12065550100",
    };
    const store = makeDb(
      [event({ rescheduleNotificationGeneration: generationA, guestRescheduleReply: legacyA })],
      undefined,
      undefined,
      {
        afterWrite: (rows, writeCount) => {
          if (writeCount <= 3) {
            rows[0] = event({ rescheduleNotificationGeneration: generationA, guestRescheduleReply: legacyA });
            return;
          }
          rows[0] = event({
            rescheduleNotificationGeneration: "terminal-generation",
            guestRescheduleReply: {
              ...legacyA,
              generation: "terminal-generation",
              version: `tour-1:${start}:${end}:+12065550100:terminal-generation`,
              status: "confirmed",
              smsEligibility: "eligible",
            },
          });
        },
      },
    );

    await expect(handleTourRescheduleSmsReply(store.db, {
      managerUserId: "manager-1", fromPhone: "+12065550100", toPhone: "+12065550999", body: "YES", messageSid: "SM-bounded",
    })).resolves.toMatchObject({ handled: true, kind: "stale" });
    expect(store.writeCount()).toBeLessThanOrEqual(3);
    expect(store.rows()[0]?.guestRescheduleReply).not.toHaveProperty("inboundMessageSid");
  });

  it("treats generationless legacy rows as compatible only when both input and row are absent", async () => {
    const store = makeDb([event()]);
    await expect(recordTourRescheduleSmsProposal(store.db, {
      managerUserId: "manager-1", inquiryId: "inquiry-1", phone: "+12065550100", start, end,
    })).resolves.toBe(true);
    expect(store.rows()[0]?.rescheduleNotificationGeneration).toBeUndefined();
  });

  it("fails closed when the caller omits generation for a row with a present generation", async () => {
    const store = makeDb([event({ rescheduleNotificationGeneration: "present-generation" })]);
    await expect(recordTourRescheduleSmsProposal(store.db, {
      managerUserId: "manager-1", inquiryId: "inquiry-1", phone: "+12065550100", start, end,
    })).resolves.toBe(false);
    expect(store.rows()[0]?.guestRescheduleReply).toBeUndefined();
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
    const generation = "persisted-reschedule-generation";
    const store = makeDb([event({ rescheduleNotificationGeneration: generation })]);
    resolveActiveManagerSendNumber.mockResolvedValueOnce("+12065550999").mockResolvedValueOnce("+12065550888");
    const proposalInput = {
      managerUserId: "manager-1", inquiryId: "inquiry-1", phone: "+12065550100", start, end,
      generation,
    };
    await recordTourRescheduleSmsProposal(store.db, proposalInput);
    (store.rows()[0]?.guestRescheduleReply as { status: string }).status = "confirmed";
    await expect(recordTourRescheduleSmsProposal(store.db, proposalInput)).resolves.toBe(false);
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

  it("accepts normalized equivalent phone formats but rejects a different work number", async () => {
    const store = makeDb([event()]);
    await recordTourRescheduleSmsProposal(store.db, {
      managerUserId: "manager-1", inquiryId: "inquiry-1", phone: "(206) 555-0100", start, end,
    });
    await expect(handleTourRescheduleSmsReply(store.db, {
      managerUserId: "manager-1", fromPhone: "(206) 555-0100", toPhone: "(206) 555-0999", body: "YES", messageSid: "SM-normalized",
    })).resolves.toMatchObject({ handled: true, kind: "confirmed" });
    await expect(handleTourRescheduleSmsReply(store.db, {
      managerUserId: "manager-1", fromPhone: "(206) 555-0100", toPhone: "+12065550888", body: "YES", messageSid: "SM-wrong-channel",
    })).resolves.toEqual({ handled: false });
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
    let contestedReadReached = false;
    const store = makeDb([event({ guestRescheduleReply: {
      version: `tour-1:${start}:${end}:+12065550100:+12065550999`, proposedStart: start, proposedEnd: end, requestedAt: start,
      status: "awaiting_reply", phoneE164: "+12065550100", workNumber: "+12065550999", conversationKey: "key", smsEligibility: "eligible",
    } })], (readCount, rows) => {
      if (readCount === 3) {
        contestedReadReached = true;
        rows[0]!.start = "2026-09-13T18:00:00.000Z";
      }
    });
    await expect(handleTourRescheduleSmsReply(store.db, {
      managerUserId: "manager-1", fromPhone: "+12065550100", toPhone: "+12065550999", body: "YES", messageSid: "SM-race",
    })).resolves.toMatchObject({ handled: true, kind: "stale" });
    expect(contestedReadReached).toBe(true);
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
