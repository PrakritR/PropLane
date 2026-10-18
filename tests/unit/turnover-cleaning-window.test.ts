/* eslint-disable @typescript-eslint/no-explicit-any -- loose recorders for mocked rows */
/**
 * The turnover cleaning window (bookings-times-1018): checkout -> the next guest's real check-in,
 * on the dispatch run's `details.whenLabel` / `deadline_at`, re-timed when a stay's times move.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const created: Array<Record<string, any>> = [];
const events: Array<Record<string, any>> = [];
const texts: Array<Record<string, any>> = [];
let stayLoaders: { channel: unknown[]; lease: unknown[]; blocks: unknown[] } = { channel: [], lease: [], blocks: [] };
let propertyTimes: Record<string, unknown> | undefined;

vi.mock("@/lib/agent-notify.server", () => ({ notifyManagerFromAgent: async () => undefined }));
vi.mock("@/lib/communication/manager-assistant-workspace.server", () => ({ userDefaultWorkspaceId: async () => "ws-1" }));
vi.mock("@/lib/vendor-dispatch/match.server", () => ({
  workspaceHasMatchingRule: async () => true,
  isMissingRelationError: () => false,
}));
vi.mock("@/lib/vendor-dispatch/engine.server", () => ({
  loadHouse: async () => ({ label: "5259 Brooklyn", address: "5259 Brooklyn Ave NE", area: "University District" }),
  loadAttempts: async () => [{ status: "accepted", vendor_directory_id: "vendor-1" }],
  loadVendorContacts: async () => new Map([["vendor-1", { id: "vendor-1", name: "Sam Cleaner", firstName: "Sam", phone: "+12065550100", vendorUserId: null }]]),
}));
vi.mock("@/lib/vendor-dispatch/runs.server", () => ({
  createDispatchRun: async (_db: unknown, input: Record<string, any>) => {
    created.push(input);
    return { ok: true, created: true, run: {} };
  },
}));
vi.mock("@/lib/vendor-dispatch/audit.server", () => ({
  recordDispatchEvent: async (_db: unknown, input: Record<string, any>) => {
    events.push(input);
    return true;
  },
}));
vi.mock("@/lib/vendor-dispatch/send.server", () => ({
  sendVendorDispatchText: async (_db: unknown, input: Record<string, any>) => {
    texts.push(input);
    return { ok: true, outboxId: null };
  },
}));
vi.mock("@/lib/reminders/subjects/bookings.server", () => ({
  channelStays: async () => stayLoaders.channel,
  leaseStays: async () => stayLoaders.lease,
  roomDateBlockStays: async () => stayLoaders.blocks,
}));

import { dispatchCleaningForStays, nextCheckInAfter, type TurnoverStay } from "@/lib/vendor-dispatch/triggers.server";
import { refreshTurnoverCleaningTimes } from "@/lib/vendor-dispatch/turnover-timing.server";
import { nextStayAfter, turnoverWindow } from "@/lib/vendor-dispatch/turnover-window";
import { DEFAULT_PROPERTY_STAY_TIMES } from "@/lib/bookings/stay-times";

const PACIFIC = { times: DEFAULT_PROPERTY_STAY_TIMES, timeZone: "America/Los_Angeles" };

function stay(overrides: Partial<TurnoverStay> = {}): TurnoverStay {
  return {
    managerUserId: "owner-1",
    subjectId: "block:out",
    checkInKey: "2026-10-16",
    checkOutKey: "2026-10-19",
    propertyId: "house-1",
    propertyLabel: "5259 Brooklyn",
    roomId: "room-a",
    roomLabel: "Room A",
    ...overrides,
  };
}

const fakeDb = {
  from(table: string) {
    const row =
      table === "manager_property_records"
        ? { manager_user_id: "owner-1", workspace_id: "ws-1", row_data: { zip: "98105" }, property_data: { listingSubmission: { zip: "98105", ...(propertyTimes ? { stayTimes: propertyTimes } : {}) } } }
        : null;
    const api: any = { eq: () => api, maybeSingle: () => Promise.resolve({ data: row, error: null }) };
    return { select: () => api };
  },
} as never;

beforeEach(() => {
  created.length = 0;
  events.length = 0;
  texts.length = 0;
  stayLoaders = { channel: [], lease: [], blocks: [] };
  propertyTimes = undefined;
});

describe("turnoverWindow", () => {
  it("runs from this checkout to the next guest's check-in: 'Oct 19, 11:00 am – 3:00 pm', deadline the next check-in instant", () => {
    const next = stay({ subjectId: "block:in", checkInKey: "2026-10-19", checkOutKey: "2026-10-22" });
    const window = turnoverWindow({ ...stay(), checkOutKey: "2026-10-19" }, next, PACIFIC);
    expect(window.whenLabel).toBe("Oct 19, 11:00 am – 3:00 pm");
    expect(window.deadlineLabel).toBe("check-in 3:00 pm");
    // 15:00 PDT = 22:00Z, not the old 09:00 Pacific date anchor.
    expect(window.deadlineIso).toBe("2026-10-19T22:00:00.000Z");
    expect(window.startAt).toBe("2026-10-19T18:00:00.000Z");
    expect(window.shortGap).toBe(false);
    expect(window.note).toBeUndefined();
  });

  it("flags a short gap when the next guest arrives sooner than the cleaning buffer (a paid early check-in)", () => {
    const next = stay({ subjectId: "block:in", checkInKey: "2026-10-19", checkOutKey: "2026-10-22", checkInTime: "12:00" });
    const window = turnoverWindow({ ...stay(), checkOutKey: "2026-10-19" }, next, PACIFIC);
    expect(window.whenLabel).toBe("Oct 19, 11:00 am – 12:00 pm");
    expect(window.shortGap).toBe(true);
    expect(window.note).toBe("Tight turnover: the next guest checks in 1 h after checkout.");
  });

  it("follows a paid late checkout and a property's own default times", () => {
    const next = stay({ subjectId: "block:in", checkInKey: "2026-10-19", checkOutKey: "2026-10-22" });
    const late = turnoverWindow({ ...stay(), checkOutKey: "2026-10-19", checkOutTime: "14:00" }, next, PACIFIC);
    expect(late.whenLabel).toBe("Oct 19, 2:00 pm – 3:00 pm");
    expect(late.shortGap).toBe(true);
    const custom = turnoverWindow({ ...stay(), checkOutKey: "2026-10-19" }, next, {
      ...PACIFIC,
      times: { ...DEFAULT_PROPERTY_STAY_TIMES, checkInTime: "16:00", checkOutTime: "10:00" },
    });
    expect(custom.whenLabel).toBe("Oct 19, 10:00 am – 4:00 pm");
  });

  it("has no deadline when nobody checks in next: checkout + the buffer is the open end", () => {
    const window = turnoverWindow({ ...stay(), checkOutKey: "2026-10-19" }, null, PACIFIC);
    expect(window.whenLabel).toBe("after checkout Oct 19, 11:00 am");
    expect(window.deadlineIso).toBeUndefined();
    expect(window.deadlineLabel).toBeUndefined();
    expect(window.endAt).toBe("2026-10-19T21:00:00.000Z");
  });

  it("names a next check-in on a later day with its date", () => {
    const next = stay({ subjectId: "block:in", checkInKey: "2026-10-21", checkOutKey: "2026-10-24" });
    expect(turnoverWindow({ ...stay(), checkOutKey: "2026-10-19" }, next, PACIFIC).whenLabel).toBe("Oct 19, 11:00 am – Oct 21, 3:00 pm");
  });

  it("picks the earliest later check-in on the same room only", () => {
    const stays = [
      stay(),
      stay({ subjectId: "other-room", roomId: "room-b", checkInKey: "2026-10-19" }),
      stay({ subjectId: "later", checkInKey: "2026-10-25", checkOutKey: "2026-10-27" }),
      stay({ subjectId: "soon", checkInKey: "2026-10-20", checkOutKey: "2026-10-22" }),
    ];
    expect(nextStayAfter(stays, stays[0]!)?.subjectId).toBe("soon");
    expect(nextCheckInAfter(stays, stays[0]!)).toBe("2026-10-20");
  });
});

describe("dispatchCleaningForStays", () => {
  it("opens one run per checkout with the window, the next real check-in as deadline, and the short-gap note", async () => {
    const stays = [
      stay(),
      stay({ subjectId: "block:in", checkInKey: "2026-10-19", checkOutKey: "2026-10-22", checkInTime: "13:00" }),
    ];
    const result = await dispatchCleaningForStays(fakeDb, stays, { todayKey: "2026-10-19", tomorrowKey: "2026-10-20" });
    expect(result.created).toBe(1);
    const run = created[0]!;
    expect(run.sourceType).toBe("cleaning");
    expect(run.sourceId).toBe("block:out:2026-10-19");
    expect(run.details.whenLabel).toBe("Oct 19, 11:00 am – 1:00 pm");
    expect(run.details.deadlineIso).toBe("2026-10-19T20:00:00.000Z");
    expect(run.details.deadlineLabel).toBe("check-in 1:00 pm");
    expect(run.details.summary).toBe("Tight turnover: the next guest checks in 2 h after checkout.");
  });

  it("reads the property's default times from its own settings", async () => {
    propertyTimes = { checkInTime: "16:00", checkOutTime: "10:00" };
    const stays = [stay(), stay({ subjectId: "block:in", checkInKey: "2026-10-19", checkOutKey: "2026-10-22" })];
    await dispatchCleaningForStays(fakeDb, stays, { todayKey: "2026-10-19", tomorrowKey: "2026-10-20" });
    expect(created[0]!.details.whenLabel).toBe("Oct 19, 10:00 am – 4:00 pm");
  });

  it("skips a checkout outside today and tomorrow", async () => {
    const result = await dispatchCleaningForStays(fakeDb, [stay()], { todayKey: "2026-10-17", tomorrowKey: "2026-10-18" });
    expect(result).toEqual({ created: 0, checked: 0 });
  });
});

describe("refreshTurnoverCleaningTimes", () => {
  type Run = Record<string, any>;
  function runsDb(runs: Run[]) {
    const updates: Array<{ id: string; patch: Record<string, any> }> = [];
    const db = {
      from(table: string) {
        if (table === "manager_property_records") {
          return {
            select: () => {
              const api: any = { eq: () => api, maybeSingle: () => Promise.resolve({ data: { row_data: { zip: "98105" }, property_data: { listingSubmission: { zip: "98105" } } }, error: null }) };
              return api;
            },
          };
        }
        const list: any = { eq: () => list, in: () => list, then: (resolve: (value: unknown) => void) => resolve({ data: runs, error: null }) };
        return {
          select: () => list,
          update: (patch: Record<string, any>) => ({
            eq: (_col: string, id: string) => {
              updates.push({ id, patch });
              return Promise.resolve({ error: null });
            },
          }),
        };
      },
    } as never;
    return { db, updates };
  }

  const baseRun = (over: Run = {}): Run => ({
    id: "run-1",
    owner_user_id: "owner-1",
    workspace_id: "ws-1",
    handle: 7,
    source_type: "cleaning",
    source_id: "block:out:2026-10-19",
    status: "offering",
    pay_cents: 6000,
    details: { what: "Turnover clean", payModel: "flat", whenLabel: "Oct 19, 11:00 am – 3:00 pm", deadlineLabel: "check-in 3:00 pm", deadlineIso: "2026-10-19T22:00:00.000Z", summary: "old" },
    deadline_at: "2026-10-19T22:00:00.000Z",
    accepted_vendor_directory_id: null,
    ...over,
  });

  it("moves the run's window and deadline when the next guest's check-in moved earlier, and rebuilds an unanswered offer", async () => {
    stayLoaders.blocks = [stay(), stay({ subjectId: "block:in", checkInKey: "2026-10-19", checkOutKey: "2026-10-22", checkInTime: "12:00" })];
    const { db, updates } = runsDb([baseRun()]);
    await refreshTurnoverCleaningTimes(db, { ownerUserId: "owner-1", propertyId: "house-1", roomId: "room-a", checkOutDate: "2026-10-19" });
    expect(updates).toHaveLength(1);
    const patch = updates[0]!.patch;
    expect(patch.details.whenLabel).toBe("Oct 19, 11:00 am – 12:00 pm");
    expect(patch.details.summary).toContain("Tight turnover");
    expect(patch.deadline_at).toBe("2026-10-19T19:00:00.000Z");
    expect(patch.offer_text).toContain("12:00 pm");
    expect(events[0]!.event).toBe("window_changed");
    expect(texts).toHaveLength(0);
  });

  it("tells a vendor who already accepted the new window", async () => {
    stayLoaders.blocks = [stay({ checkOutTime: "14:00" }), stay({ subjectId: "block:in", checkInKey: "2026-10-19", checkOutKey: "2026-10-22" })];
    const { db, updates } = runsDb([baseRun({ status: "accepted", accepted_vendor_directory_id: "vendor-1" })]);
    await refreshTurnoverCleaningTimes(db, { ownerUserId: "owner-1", propertyId: "house-1", roomId: "room-a", checkOutDate: "2026-10-19" });
    expect(updates[0]!.patch.offer_text).toBeUndefined();
    expect(texts).toHaveLength(1);
    expect(texts[0]!.phone).toBe("+12065550100");
    expect(texts[0]!.text).toContain("Oct 19, 2:00 pm – 3:00 pm");
    expect(texts[0]!.idempotencyKey).toContain("run-1");
  });

  it("changes nothing when the window did not move", async () => {
    stayLoaders.blocks = [stay(), stay({ subjectId: "block:in", checkInKey: "2026-10-19", checkOutKey: "2026-10-22" })];
    const { db, updates } = runsDb([baseRun()]);
    await refreshTurnoverCleaningTimes(db, { ownerUserId: "owner-1", propertyId: "house-1", roomId: "room-a", checkOutDate: "2026-10-19" });
    expect(updates).toEqual([]);
    expect(texts).toEqual([]);
  });

  it("never throws, even when the read fails", async () => {
    const broken = { from: () => { throw new Error("db down"); } } as never;
    await expect(refreshTurnoverCleaningTimes(broken, { ownerUserId: "owner-1", propertyId: "house-1", roomId: "room-a", checkOutDate: "2026-10-19" })).resolves.toBeUndefined();
  });
});
