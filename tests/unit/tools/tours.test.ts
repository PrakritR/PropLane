/**
 * The tour tools. What is actually load-bearing here — everything else is
 * delegation to libs with their own coverage — is that the agent can never act
 * on a time the public grid is not offering:
 *
 *  - the offered set comes from `listOpenTourSlots` and nowhere else,
 *  - it is re-checked in the HANDLER as well as the preview, because a slot open
 *    when a proposal was written can be taken before anyone confirms it, and
 *  - `book_tour` only accepts a slot whose host is the acting landlord.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const listOpenTourSlots = vi.fn();
const createTourInquiry = vi.fn();
const createManualPlannedTour = vi.fn();

vi.mock("@/lib/tour-availability.server", () => ({
  listOpenTourSlots: (...a: unknown[]) => listOpenTourSlots(...a),
}));
vi.mock("@/lib/tour-inquiry-create.server", () => ({
  createTourInquiry: (...a: unknown[]) => createTourInquiry(...a),
}));
vi.mock("@/lib/manual-planned-tour.server", () => ({
  createManualPlannedTour: (...a: unknown[]) => createManualPlannedTour(...a),
}));
vi.mock("@/lib/tour-planned-change.server", () => ({
  cancelPlannedTour: vi.fn(async () => ({ ok: true, message: "cancelled", guestNotification: { ok: true }, calendarSync: { ok: true } })),
  reschedulePlannedTour: vi.fn(async () => ({ ok: true, message: "moved", guestNotification: { ok: true }, calendarSync: { ok: true } })),
}));

import { slotStartMs } from "@/lib/tour-slot-math";
import type { AgentContext } from "@/lib/tools/context";
import {
  bookTourTool,
  leasingRequestTourTool,
  listOpenTourSlotsTool,
  residentRequestTourTool,
} from "@/lib/tools/domains/tours";
import { LEASING_SMS_INLINE_WRITE_TOOLS } from "@/lib/tools";
import { previewWrite, executeWrite } from "./fake-agent-ctx";

const MGR = "mgr-1";
const OTHER_MGR = "mgr-2";
// A slot key is `YYYY-MM-DD:<half-hour index>` in PACIFIC wall time — index 28
// is 2:00 PM. The instants are derived with the same math the tools use rather
// than hand-written, because hand-converting a wall time is the exact mistake
// `tour-slot-math` exists to prevent (UTC on Vercel silently double-books).
const SLOT_KEY = "2026-09-10:28";
const SLOT_START_MS = slotStartMs(SLOT_KEY)!;
const START = new Date(SLOT_START_MS).toISOString();
const END = new Date(SLOT_START_MS + 30 * 60 * 1000).toISOString();

/** Only the audit + db surface these tools touch. */
function makeCtx(landlordId = MGR): AgentContext {
  const auditRows: Record<string, unknown>[] = [];
  const db = {
    from: () => ({
      insert: async (row: Record<string, unknown>) => {
        auditRows.push(row);
        return { error: null };
      },
      update: () => ({ eq: () => ({ eq: async () => ({ error: null }) }) }),
    }),
  };
  return {
    landlordId,
    userId: landlordId,
    email: "mgr@example.com",
    roles: ["manager"],
    isAdmin: false,
    db: db as unknown as AgentContext["db"],
  };
}

/** `listOpenTourSlots` returns wall-time slot keys mapped to their hosts. */
function offerSlot(hostUserId = MGR) {
  listOpenTourSlots.mockResolvedValue({
    ok: true,
    slotHosts: { [SLOT_KEY]: [{ userId: hostUserId, label: "Pat M." }] },
  });
}

function offerNothing() {
  listOpenTourSlots.mockResolvedValue({ ok: true, slotHosts: {} });
}

const REQUEST_INPUT = {
  propertyId: "prop-1",
  propertyTitle: "12 Main",
  slotKey: SLOT_KEY,
  start: START,
  end: END,
  hostUserId: MGR,
  name: "Jane Rivera",
  email: "jane@example.com",
  phone: "2065550100",
};

const BOOK_INPUT = {
  propertyId: "prop-1",
  propertyTitle: "12 Main",
  guestName: "Jane Rivera",
  start: START,
  end: END,
};

beforeEach(() => {
  vi.clearAllMocks();
  createTourInquiry.mockResolvedValue({ ok: true, row: {}, inquiryId: "inq-1" });
  createManualPlannedTour.mockResolvedValue({ ok: true, plannedEvent: {}, message: "Thu 2:00 PM" });
});

describe("list_open_tour_slots", () => {
  it("derives real ISO bounds from the wall-time slot key, so no caller has to", async () => {
    offerSlot();
    const out = await listOpenTourSlotsTool.handler(makeCtx(), { propertyId: "prop-1" });
    expect(out.slots).toHaveLength(1);
    expect(out.slots[0]).toMatchObject({ slotKey: SLOT_KEY, hostUserId: MGR });
    // A slot key is wall time pinned to Pacific; the tool must hand back an
    // instant, never leave the model to construct one.
    expect(Date.parse(out.slots[0]!.start)).toBeGreaterThan(0);
    expect(Date.parse(out.slots[0]!.end) - Date.parse(out.slots[0]!.start)).toBe(30 * 60 * 1000);
    expect(out.timeZone).toBe("America/Los_Angeles");
  });

  it("surfaces a failure instead of reporting an empty grid as 'nothing open'", async () => {
    listOpenTourSlots.mockResolvedValue({ ok: false, error: "boom" });
    await expect(listOpenTourSlotsTool.handler(makeCtx(), { propertyId: "prop-1" })).rejects.toThrow("boom");
  });
});

describe("request_tour — files a request, books nothing", () => {
  it("previews the exact time and says the manager still confirms", async () => {
    offerSlot();
    const res = await previewWrite(leasingRequestTourTool, makeCtx(), REQUEST_INPUT);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.preview.warnings?.join(" ")).toMatch(/manager confirms/i);
    expect(createTourInquiry).not.toHaveBeenCalled();
  });

  it("refuses a slot that is not on offer", async () => {
    offerNothing();
    const res = await previewWrite(leasingRequestTourTool, makeCtx(), REQUEST_INPUT);
    expect(res).toMatchObject({ ok: false });
    if (res.ok) return;
    expect(res.error).toMatch(/no longer open/i);
  });

  it("re-checks in the HANDLER, so a slot taken after the preview is refused", async () => {
    offerSlot();
    const preview = await previewWrite(leasingRequestTourTool, makeCtx(), REQUEST_INPUT);
    expect(preview.ok).toBe(true);
    // Someone else books it between propose and confirm.
    offerNothing();
    const res = await executeWrite(leasingRequestTourTool, makeCtx(), REQUEST_INPUT);
    expect(res.ok).toBe(false);
    expect(createTourInquiry).not.toHaveBeenCalled();
  });

  it("refuses a host who does not hold that slot", async () => {
    offerSlot(OTHER_MGR);
    const res = await previewWrite(leasingRequestTourTool, makeCtx(), REQUEST_INPUT);
    expect(res).toMatchObject({ ok: false });
  });

  it("files a pending request carrying the requested window and host", async () => {
    offerSlot();
    const res = await executeWrite(leasingRequestTourTool, makeCtx(), REQUEST_INPUT);
    expect(res.ok).toBe(true);
    const incoming = createTourInquiry.mock.calls[0]![1].incoming;
    expect(incoming).toMatchObject({ kind: "tour", managerUserId: MGR, propertyId: "prop-1" });
    expect(incoming.requestedWindows).toEqual([
      { start: START, end: END, slotKey: SLOT_KEY, adminUserId: MGR },
    ]);
    // Status is set by createTourInquiry and defaults to pending — the tool
    // must never assert a booked/accepted state of its own.
    expect(incoming.status).toBeUndefined();
  });

  it("is offered to residents under the same name and contract", async () => {
    offerSlot();
    expect(residentRequestTourTool.name).toBe(leasingRequestTourTool.name);
    const res = await previewWrite(residentRequestTourTool, makeCtx() as never, REQUEST_INPUT);
    expect(res.ok).toBe(true);
  });
});

describe("book_tour — the manager's own calendar only", () => {
  it("books a slot the landlord hosts", async () => {
    offerSlot(MGR);
    const res = await executeWrite(bookTourTool, makeCtx(), BOOK_INPUT);
    expect(res.ok).toBe(true);
    expect(createManualPlannedTour).toHaveBeenCalledWith(
      expect.anything(),
      MGR,
      expect.objectContaining({ propertyId: "prop-1", start: START, end: END }),
    );
  });

  it("refuses a slot hosted by a DIFFERENT manager — scope isolation", async () => {
    offerSlot(OTHER_MGR);
    const res = await previewWrite(bookTourTool, makeCtx(MGR), BOOK_INPUT);
    expect(res).toMatchObject({ ok: false });
    const exec = await executeWrite(bookTourTool, makeCtx(MGR), BOOK_INPUT);
    expect(exec.ok).toBe(false);
    expect(createManualPlannedTour).not.toHaveBeenCalled();
  });

  it("refuses a time that is not open at all", async () => {
    offerNothing();
    expect(await previewWrite(bookTourTool, makeCtx(), BOOK_INPUT)).toMatchObject({ ok: false });
  });

  it("warns that booking takes the slot off the public page", async () => {
    offerSlot();
    const res = await previewWrite(bookTourTool, makeCtx(), BOOK_INPUT);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.preview.warnings?.join(" ")).toMatch(/public booking page/i);
  });
});

describe("leasing SMS inline write allowlist", () => {
  it("holds exactly the two request-shaped tools and nothing that books or charges", () => {
    // A texting prospect is anonymous, so nothing here can ever be confirmed.
    // Both entries must be actions that only notify the manager.
    expect([...LEASING_SMS_INLINE_WRITE_TOOLS].sort()).toEqual(["escalate_to_manager", "request_tour"]);
  });
});
