import { beforeEach, describe, expect, it, vi } from "vitest";

const listOpenTourSlots = vi.fn();
const prepareProspectSmsTourOffer = vi.fn();
const confirmProspectSmsTourOffer = vi.fn();
const loadConfirmedProspectTourBooking = vi.fn();
const recoverProspectTourBookingSideEffects = vi.fn();

vi.mock("@/lib/tour-availability.server", () => ({
  listOpenTourSlots: (...args: unknown[]) => listOpenTourSlots(...args),
}));
vi.mock("@/lib/tour-schedule-persistence.server", () => ({
  prepareProspectSmsTourOffer: (...args: unknown[]) => prepareProspectSmsTourOffer(...args),
  confirmProspectSmsTourOffer: (...args: unknown[]) => confirmProspectSmsTourOffer(...args),
}));
vi.mock("@/lib/prospect-tour-booking-recovery.server", () => ({
  loadConfirmedProspectTourBooking: (...args: unknown[]) => loadConfirmedProspectTourBooking(...args),
  recoverProspectTourBookingSideEffects: (...args: unknown[]) => recoverProspectTourBookingSideEffects(...args),
}));

import type { AgentContext } from "@/lib/tools/context";
import { slotStartMs } from "@/lib/tour-slot-math";
import {
  LEASING_SMS_AUTONOMOUS_TOUR_WRITE_TOOLS,
  LEASING_SMS_INLINE_WRITE_TOOLS,
  leasingSmsAgentRegistry,
  leasingSmsAutonomousTourRegistry,
} from "@/lib/tools";
import { confirmProspectSmsTourTool, prepareProspectTourConfirmationTool } from "@/lib/tools/domains/tours";
import { executeWrite } from "./fake-agent-ctx";

const MANAGER = "11111111-1111-4111-8111-111111111111";
const OTHER_MANAGER = "22222222-2222-4222-8222-222222222222";
const SLOT = {
  slotKey: "2099-09-10:20",
  start: "2099-09-10T17:00:00.000Z",
  end: "2099-09-10T17:30:00.000Z",
  hostUserId: MANAGER,
};

function ctx(revision = 7, agreementBody = "YES"): AgentContext {
  const query: Record<string, unknown> = {};
  const chain = () => query;
  query.select = chain;
  query.eq = chain;
  query.in = chain;
  query.order = chain;
  query.then = (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
    Promise.resolve({ data: [{ source_message_id: "source-1", body: agreementBody }], error: null }).then(resolve, reject);
  return {
    landlordId: MANAGER,
    userId: MANAGER,
    email: "manager@example.test",
    roles: ["leasing_sms_agent"],
    isAdmin: false,
    db: { from: () => query } as unknown as AgentContext["db"],
    leasingScope: {
      sessionId: "session-1",
      prospectPhoneE164: "+12065550123",
      workNumber: "+12055550100",
      crossCatalog: true,
      prospectBurst: { burstId: "burst-1", revision, workerId: "worker-1", claimedSourceIds: ["source-1"] },
    },
  };
}

function offered(slot = SLOT) {
  listOpenTourSlots.mockResolvedValue({
    ok: true,
    resolution: "resolved",
    slotHosts: { [slot.slotKey]: [{ userId: slot.hostUserId, label: "Pat Manager" }] },
  });
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    propertyId: "property-1",
    propertyTitle: "Ballard House",
    slotKey: SLOT.slotKey,
    start: SLOT.start,
    end: SLOT.end,
    hostUserId: SLOT.hostUserId,
    name: "Jordan Lee",
    agreementSourceMessageId: "source-1",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.PROSPECT_TOUR_FAULT_AFTER_COMMIT;
  loadConfirmedProspectTourBooking.mockImplementation(async () =>
    confirmProspectSmsTourOffer.mock.calls.length > 0 ? ({
      id: "booking-1",
      manager_user_id: MANAGER,
      planned_event_id: "planned-1",
      offer_snapshot: { ...SLOT, label: "Thursday, September 10, 2099 at 10:00 AM Pacific" },
      event_snapshot: {},
      status: "confirmed",
    }) : null);
  recoverProspectTourBookingSideEffects.mockResolvedValue({
    calendarSync: { ok: true, skipped: true },
    managerNotification: { ok: true },
  });
  prepareProspectSmsTourOffer.mockResolvedValue({ ok: true, stateId: "state-1", stateRevision: 1 });
  confirmProspectSmsTourOffer.mockResolvedValue({
    ok: true,
    idempotent: false,
    plannedEventId: "planned-1",
    status: "confirmed",
  });
});

describe("confirm_prospect_sms_tour", () => {
  it("exists only in the autonomous SMS registry, not the ordinary leasing registry", () => {
    expect(leasingSmsAgentRegistry.get("confirm_prospect_sms_tour")).toBeUndefined();
    expect(leasingSmsAutonomousTourRegistry.get("confirm_prospect_sms_tour")).toBe(confirmProspectSmsTourTool);
    expect(leasingSmsAutonomousTourRegistry.get("prepare_prospect_tour_confirmation")).toBe(prepareProspectTourConfirmationTool);
    expect(LEASING_SMS_AUTONOMOUS_TOUR_WRITE_TOOLS).toContain("confirm_prospect_sms_tour");
    expect(LEASING_SMS_AUTONOMOUS_TOUR_WRITE_TOOLS).toContain("prepare_prospect_tour_confirmation");
    expect(LEASING_SMS_AUTONOMOUS_TOUR_WRITE_TOOLS).not.toContain("request_tour");
    expect(LEASING_SMS_INLINE_WRITE_TOOLS).toContain("request_tour");
    expect(LEASING_SMS_INLINE_WRITE_TOOLS).not.toContain("confirm_prospect_sms_tour");
  });

  it("rechecks a selected later slot by date and Pacific minute, before the 40-slot cap", async () => {
    const laterSlot = {
      slotKey: "2099-09-10:40",
      start: new Date(slotStartMs("2099-09-10:40")!).toISOString(),
      end: new Date(slotStartMs("2099-09-10:40")! + 30 * 60 * 1000).toISOString(),
      hostUserId: MANAGER,
    };
    const slotHosts: Record<string, { userId: string; label: string }[]> = {};
    for (let index = 0; index < 45; index += 1) {
      slotHosts[`2099-09-10:${index}`] = [{ userId: MANAGER, label: "Pat Manager" }];
    }
    listOpenTourSlots.mockResolvedValue({
      ok: true,
      resolution: "resolved",
      slotHosts,
    });

    const response = await executeWrite(confirmProspectSmsTourTool, ctx(), input(laterSlot));
    expect(response).toMatchObject({ ok: true });
    expect(listOpenTourSlots).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      propertyId: "property-1",
      publishedOnly: true,
    }));
    expect(confirmProspectSmsTourOffer).toHaveBeenCalledTimes(1);
  });

  it("recovers a booking committed before a worker crash without rechecking its now-occupied slot", async () => {
    offered();
    process.env.PROSPECT_TOUR_FAULT_AFTER_COMMIT = "1";
    const crashed = await executeWrite(confirmProspectSmsTourTool, ctx(), input());
    expect(crashed).toMatchObject({ ok: false });
    expect(confirmProspectSmsTourOffer).toHaveBeenCalledTimes(1);

    delete process.env.PROSPECT_TOUR_FAULT_AFTER_COMMIT;
    listOpenTourSlots.mockClear();
    const retry = await executeWrite(confirmProspectSmsTourTool, ctx(), input());
    expect(retry).toMatchObject({
      ok: true,
      booking: { idempotent: true, plannedEventId: "planned-1" },
    });
    expect(listOpenTourSlots).not.toHaveBeenCalled();
    expect(recoverProspectTourBookingSideEffects).toHaveBeenCalledTimes(1);
    expect(confirmProspectSmsTourOffer).toHaveBeenCalledTimes(1);
  });

  it("derives the trusted inbound phone and forwards an optional email", async () => {
    offered();
    const result = await executeWrite(confirmProspectSmsTourTool, ctx(), input({ email: "jordan@example.test" }));
    expect(result).toMatchObject({ ok: true });
    expect(confirmProspectSmsTourOffer).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      managerUserId: MANAGER,
      trustedPhoneE164: "+12065550123",
      contactName: "Jordan Lee",
      contactEmail: "jordan@example.test",
      propertyId: "property-1",
      offer: expect.objectContaining({ slotKey: SLOT.slotKey, policy: "published_only", burstId: "burst-1", revision: 7 }),
    }));
    expect(listOpenTourSlots).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      propertyId: "property-1",
      publishedOnly: true,
    }));
    const event = confirmProspectSmsTourOffer.mock.calls[0]?.[1].event;
    expect(event).toMatchObject({ attendeePhone: "+12065550123", attendeeEmail: "jordan@example.test", smsAutonomous: true });
  });

  it("requires an affirmative answer to the prepared exact question, not a new time or weekday", async () => {
    offered({ ...SLOT, slotKey: "2099-09-10:21", start: new Date(slotStartMs("2099-09-10:21")!).toISOString(), end: new Date(slotStartMs("2099-09-10:21")! + 30 * 60 * 1000).toISOString() });
    const halfHour = { ...SLOT, slotKey: "2099-09-10:21", start: new Date(slotStartMs("2099-09-10:21")!).toISOString(), end: new Date(slotStartMs("2099-09-10:21")! + 30 * 60 * 1000).toISOString() };
    for (const body of [
      "YES, 10am works for me",
      "Yes, Tuesday at 10am works for me",
      "yes, I cannot do 10am",
      "Yes, the same time at the prior property works",
    ]) {
      const response = await executeWrite(confirmProspectSmsTourTool, ctx(7, body), input(halfHour));
      expect(response).toMatchObject({ ok: false });
    }
    expect(confirmProspectSmsTourOffer).not.toHaveBeenCalled();
  });

  it("confirms YES after persisting the exact offer preparation", async () => {
    offered();
    const prepared = await executeWrite(prepareProspectTourConfirmationTool, ctx(), input());
    expect(prepared).toMatchObject({ ok: true, preparedOffer: { slotKey: SLOT.slotKey, policy: "published_only" } });
    expect(prepareProspectSmsTourOffer).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      propertyId: "property-1",
      trustedPhoneE164: "+12065550123",
      offer: expect.objectContaining({ slotKey: SLOT.slotKey, policy: "published_only" }),
    }));

    const confirmed = await executeWrite(confirmProspectSmsTourTool, ctx(7, "YES"), input());
    expect(confirmed).toMatchObject({ ok: true, booking: { plannedEventId: "planned-1" } });
    expect(confirmProspectSmsTourOffer).toHaveBeenCalledTimes(1);
  });

  it("permits a missing email but never a missing name", async () => {
    offered();
    expect(await executeWrite(confirmProspectSmsTourTool, ctx(), input())).toMatchObject({ ok: true });
    expect(confirmProspectSmsTourOffer.mock.calls[0]?.[1].contactEmail).toBeUndefined();

    const missingName = confirmProspectSmsTourTool.inputSchema.safeParse(input({ name: " " }));
    expect(missingName.success).toBe(false);
    expect(confirmProspectSmsTourOffer).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["stale or expired", { slotHosts: {} }],
    ["unpublished", { slotHosts: {}, resolution: "resolved" }],
    ["unknown property", { slotHosts: {}, resolution: "unavailable" }],
  ])("rejects an %s exact offer without booking", async (_label, result) => {
    listOpenTourSlots.mockResolvedValue({ ok: true, ...result });
    const response = await executeWrite(confirmProspectSmsTourTool, ctx(), input());
    expect(response).toMatchObject({ ok: false });
    expect(confirmProspectSmsTourOffer).not.toHaveBeenCalled();
  });

  it("rejects a changed property, changed slot bounds, or changed host instead of widening the offer", async () => {
    listOpenTourSlots.mockImplementation(async (_db: unknown, args: { propertyId: string }) =>
      args.propertyId === "property-1"
        ? { ok: true, resolution: "resolved", slotHosts: { [SLOT.slotKey]: [{ userId: MANAGER, label: "Pat Manager" }] } }
        : { ok: true, resolution: "unavailable", slotHosts: {} },
    );
    expect(await executeWrite(confirmProspectSmsTourTool, ctx(), input({ propertyId: "property-2" }))).toMatchObject({ ok: false });
    expect(await executeWrite(confirmProspectSmsTourTool, ctx(), input({ start: "2099-09-10T17:30:00.000Z" }))).toMatchObject({ ok: false });
    offered({ ...SLOT, hostUserId: OTHER_MANAGER });
    expect(await executeWrite(confirmProspectSmsTourTool, ctx(), input({ hostUserId: OTHER_MANAGER }))).toMatchObject({ ok: false });
    expect(confirmProspectSmsTourOffer).not.toHaveBeenCalled();
  });

  it("requires a current durable burst lease and carries the newer revision", async () => {
    offered();
    expect(await executeWrite(confirmProspectSmsTourTool, ctx(8), input())).toMatchObject({ ok: true });
    expect(confirmProspectSmsTourOffer.mock.calls[0]?.[1]).toMatchObject({
      idempotencyKey: "prospect-tour:burst-1:8",
      offer: expect.objectContaining({ revision: 8 }),
      burstId: "burst-1",
      burstRevision: 8,
      agreementSourceMessageId: "source-1",
      claimedSourceIds: ["source-1"],
    });

    const noLease = { ...ctx(8), leasingScope: { ...ctx(8).leasingScope!, prospectBurst: undefined } };
    expect(await executeWrite(confirmProspectSmsTourTool, noLease, input())).toMatchObject({ ok: false });
  });

  it("does not run from an ordinary email or voice context", async () => {
    offered();
    const emailCtx = { ...ctx(), leasingScope: { ...ctx().leasingScope!, channel: "email" as const, prospectBurst: undefined } };
    expect(await executeWrite(confirmProspectSmsTourTool, emailCtx, input())).toMatchObject({ ok: false });
    const voiceCtx = { ...ctx(), leasingScope: { ...ctx().leasingScope!, channel: "sms" as const, prospectBurst: undefined } };
    expect(await executeWrite(confirmProspectSmsTourTool, voiceCtx, input())).toMatchObject({ ok: false });
    expect(confirmProspectSmsTourOffer).not.toHaveBeenCalled();
  });
});
