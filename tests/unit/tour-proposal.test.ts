import { describe, it, expect, vi, beforeEach } from "vitest";

// The confirm core notifies the tenant through this module — mock it so the
// "book" path never touches email/inbox tables and we can assert it fired.
const { notifyTenantTourConfirmed } = vi.hoisted(() => ({
  notifyTenantTourConfirmed: vi.fn(async () => ({ ok: true })),
}));
vi.mock("@/lib/tour-notification-delivery.server", () => ({
  notifyTenantTourConfirmed,
  // Other exports are unused here but keep the module shape intact.
  notifyManagerTourRequest: vi.fn(),
  notifyTenantTourRequestReceived: vi.fn(),
  resolvePropertyAddressForTour: vi.fn(async () => ""),
}));

import { slotStartMs } from "@/lib/tour-slot-math";
import {
  findFirstOpenTourSlot,
  loadManagerTourBlocks,
  proposeTourConfirmation,
  CONFIRM_TOUR_INQUIRY_TOOL,
} from "@/lib/tour-proposal.server";
import { runConfirmedPendingAction } from "@/lib/tools/confirm-gate.server";
import { denyPendingAction, listProposedActionsForUser } from "@/lib/tools/pending-actions";
import type { AgentContext } from "@/lib/tools/context";

const MANAGER = "manager_a";
const PROPERTY = "mgr-house-1";
const INQUIRIES_RECORD_ID = "axis_admin_partner_inquiries_v1";
const PLANNED_RECORD_ID = "axis_admin_planned_events_v1";

type Row = Record<string, unknown>;

/**
 * In-memory Supabase stand-in covering the exact chains the tour-proposal +
 * confirm flow uses: select/eq/in/gt/order/maybeSingle, insert().select().single(),
 * upsert(array), update().eq()...select(), and delete().in().
 */
class FakeQuery {
  private filters: ((r: Row) => boolean)[] = [];
  private mode: "select" | "insert" | "update" | "upsert" | "delete" = "select";
  private pendingInsert: Row | null = null;
  private pendingUpdate: Row | null = null;
  private wantSingle = false;

  constructor(private store: Record<string, Row[]>, private table: string) {
    if (!store[table]) store[table] = [];
  }
  private rows(): Row[] {
    return this.store[this.table]!;
  }
  select() {
    return this;
  }
  order() {
    return this;
  }
  limit() {
    return this;
  }
  eq(col: string, val: unknown) {
    this.filters.push((r) => r[col] === val);
    return this;
  }
  in(col: string, vals: unknown[]) {
    this.filters.push((r) => vals.includes(r[col]));
    return this;
  }
  gt(col: string, val: unknown) {
    this.filters.push((r) => String(r[col] ?? "") > String(val ?? ""));
    return this;
  }
  single() {
    this.wantSingle = true;
    return this;
  }
  maybeSingle() {
    this.wantSingle = true;
    return this;
  }
  insert(row: Row) {
    this.mode = "insert";
    const defaults =
      this.table === "agent_pending_actions"
        ? {
            status: "proposed",
            created_at: new Date().toISOString(),
            expires_at: new Date(Date.now() + 15 * 60_000).toISOString(),
          }
        : {};
    const withId = { id: `id_${this.rows().length}_${Math.random().toString(36).slice(2, 8)}`, ...defaults, ...row };
    this.rows().push(withId);
    this.pendingInsert = withId;
    return this;
  }
  upsert(rowOrRows: Row | Row[]) {
    this.mode = "upsert";
    const list = Array.isArray(rowOrRows) ? rowOrRows : [rowOrRows];
    for (const row of list) {
      const idx = this.rows().findIndex((r) => r.id === row.id);
      if (idx >= 0) this.rows()[idx] = { ...this.rows()[idx], ...row };
      else this.rows().push({ ...row });
    }
    return this;
  }
  update(vals: Row) {
    this.mode = "update";
    this.pendingUpdate = vals;
    return this;
  }
  delete() {
    this.mode = "delete";
    return this;
  }
  private resolve(): { data: unknown; error: null } {
    if (this.mode === "insert") {
      return { data: this.wantSingle ? this.pendingInsert : [this.pendingInsert], error: null };
    }
    if (this.mode === "upsert") return { data: null, error: null };
    const matched = this.rows().filter((r) => this.filters.every((f) => f(r)));
    if (this.mode === "update") {
      for (const r of matched) Object.assign(r, this.pendingUpdate);
      return { data: matched, error: null };
    }
    if (this.mode === "delete") {
      this.store[this.table] = this.rows().filter((r) => !this.filters.every((f) => f(r)));
      return { data: null, error: null };
    }
    return { data: this.wantSingle ? matched[0] ?? null : matched, error: null };
  }
  then<T>(onFulfilled: (v: { data: unknown; error: null }) => T) {
    return Promise.resolve(this.resolve()).then(onFulfilled);
  }
}

function makeDb(store: Record<string, Row[]>) {
  return { from: (table: string) => new FakeQuery(store, table) } as unknown as AgentContext["db"];
}

function managerCtx(db: AgentContext["db"]): AgentContext {
  return {
    landlordId: MANAGER,
    userId: MANAGER,
    email: "manager@axis.test",
    roles: ["manager"],
    isAdmin: false,
    db,
  } as unknown as AgentContext;
}

/** A slotKey `daysAhead` days from now at 10:00 (index 20), plus its ISO window. */
function futureWindow(daysAhead: number, slotIndex = 20) {
  const d = new Date();
  d.setDate(d.getDate() + daysAhead);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const slotKey = `${y}-${m}-${day}:${slotIndex}`;
  const startMs = slotStartMs(slotKey)!;
  return {
    slotKey,
    start: new Date(startMs).toISOString(),
    end: new Date(startMs + 30 * 60_000).toISOString(),
  };
}

function publishedAvailabilityRow(slotKeys: string[]): Row {
  return {
    id: `avail_${MANAGER}_prop_${PROPERTY}`,
    manager_user_id: MANAGER,
    property_id: PROPERTY,
    record_type: "manager_property_availability",
    row_data: { payload: slotKeys },
  };
}

function inquiriesRecord(rows: Row[]): Row {
  return { id: INQUIRIES_RECORD_ID, record_type: INQUIRIES_RECORD_ID, row_data: { payload: rows } };
}

function tourInquiry(id: string, win: { slotKey: string; start: string; end: string }): Row {
  return {
    id,
    kind: "tour",
    status: "pending",
    managerUserId: MANAGER,
    propertyId: PROPERTY,
    propertyTitle: "Maple House",
    roomLabel: "Room 2",
    name: "Jamie Rivera",
    email: "jamie@example.com",
    phone: "+12025550111",
    tourGroupId: `grp_${id}`,
    requestedWindows: [{ start: win.start, end: win.end, slotKey: win.slotKey, adminUserId: MANAGER }],
    proposedStart: win.start,
    proposedEnd: win.end,
  };
}

beforeEach(() => {
  notifyTenantTourConfirmed.mockClear();
});

describe("findFirstOpenTourSlot", () => {
  it("returns the first published, future, unblocked window", async () => {
    const w1 = futureWindow(2, 20);
    const w2 = futureWindow(2, 22);
    const store: Record<string, Row[]> = {
      portal_schedule_records: [publishedAvailabilityRow([w1.slotKey, w2.slotKey])],
    };
    const slot = await findFirstOpenTourSlot(makeDb(store), {
      managerUserId: MANAGER,
      propertyId: PROPERTY,
      requestedWindows: [w1, w2],
    });
    expect(slot).toEqual({ slotKey: w1.slotKey, start: w1.start, end: w1.end });
  });

  it("skips an unpublished window and picks the next published one", async () => {
    const w1 = futureWindow(2, 20);
    const w2 = futureWindow(2, 22);
    const store: Record<string, Row[]> = {
      portal_schedule_records: [publishedAvailabilityRow([w2.slotKey])], // only w2 published
    };
    const slot = await findFirstOpenTourSlot(makeDb(store), {
      managerUserId: MANAGER,
      propertyId: PROPERTY,
      requestedWindows: [w1, w2],
    });
    expect(slot?.slotKey).toBe(w2.slotKey);
  });

  it("skips a window already blocked by a booked tour", async () => {
    const w1 = futureWindow(2, 20);
    const w2 = futureWindow(2, 22);
    const store: Record<string, Row[]> = {
      portal_schedule_records: [
        publishedAvailabilityRow([w1.slotKey, w2.slotKey]),
        {
          id: PLANNED_RECORD_ID,
          record_type: PLANNED_RECORD_ID,
          row_data: { payload: [{ kind: "tour", managerUserId: MANAGER, start: w1.start, end: w1.end, slotKey: w1.slotKey }] },
        },
      ],
    };
    const slot = await findFirstOpenTourSlot(makeDb(store), {
      managerUserId: MANAGER,
      propertyId: PROPERTY,
      requestedWindows: [w1, w2],
    });
    expect(slot?.slotKey).toBe(w2.slotKey);
  });

  it("returns null when nothing matches (manual handling)", async () => {
    const w1 = futureWindow(2, 20);
    // "Nothing matches" has to be expressed as availability published on the
    // requested DAY that does not cover the requested TIME. An EMPTY published
    // list is not the same thing: `shouldOfferDefaultTourGrid` treats "no future
    // slot published" as a cue to offer the 9-5 default grid, so an empty list
    // makes every default hour bookable and this request WOULD match.
    // `resolveTourOfferingSlots` only skips the default on a day that already
    // carries a future published slot, which is why the painted slot has to sit
    // on the same day as `w1`.
    const store: Record<string, Row[]> = {
      portal_schedule_records: [publishedAvailabilityRow([futureWindow(2, 22).slotKey])],
    };
    const slot = await findFirstOpenTourSlot(makeDb(store), {
      managerUserId: MANAGER,
      propertyId: PROPERTY,
      requestedWindows: [w1],
    });
    expect(slot).toBeNull();
  });

  it("a past slot is never bookable", async () => {
    const past = futureWindow(-2, 20);
    const store: Record<string, Row[]> = { portal_schedule_records: [publishedAvailabilityRow([past.slotKey])] };
    const slot = await findFirstOpenTourSlot(makeDb(store), {
      managerUserId: MANAGER,
      propertyId: PROPERTY,
      requestedWindows: [past],
    });
    expect(slot).toBeNull();
  });
});

describe("loadManagerTourBlocks", () => {
  it("excludes the inquiry's own pending window so it never blocks itself", async () => {
    const w1 = futureWindow(2, 20);
    const store: Record<string, Row[]> = {
      portal_schedule_records: [
        {
          id: `partner_inquiry_request_inq_1_0`,
          manager_user_id: MANAGER,
          record_type: "partner_inquiry_request",
          row_data: { payload: tourInquiry("inq_1", w1) },
        },
      ],
    };
    const withSelf = await loadManagerTourBlocks(makeDb(store), MANAGER);
    expect(withSelf).toHaveLength(1);
    const excludingSelf = await loadManagerTourBlocks(makeDb(store), MANAGER, "inq_1");
    expect(excludingSelf).toHaveLength(0);
  });

  it("ignores soft-canceled planned tours so freed slots stay bookable", async () => {
    const w1 = futureWindow(2, 20);
    const store: Record<string, Row[]> = {
      portal_schedule_records: [
        {
          id: PLANNED_RECORD_ID,
          row_data: {
            payload: [
              {
                id: "ev_canceled",
                kind: "tour",
                managerUserId: MANAGER,
                start: w1.start,
                end: w1.end,
                slotKey: w1.slotKey,
                canceledAt: "2026-01-01T12:00:00.000Z",
              },
            ],
          },
        },
      ],
    };
    const blocks = await loadManagerTourBlocks(makeDb(store), MANAGER);
    expect(blocks).toHaveLength(0);
  });
});

describe("proposeTourConfirmation → approve → book", () => {
  it("proposes into the first open slot, and approving books the tour + notifies", async () => {
    const win = futureWindow(3, 20);
    const store: Record<string, Row[]> = {
      portal_schedule_records: [
        publishedAvailabilityRow([win.slotKey]),
        inquiriesRecord([tourInquiry("inq_book", win)]),
      ],
      agent_pending_actions: [],
    };
    const db = makeDb(store);

    const proposal = await proposeTourConfirmation(db, {
      inquiry: tourInquiry("inq_book", win),
      managerUserId: MANAGER,
      requestedWindows: [win],
    });
    expect(proposal.proposed).toBe(true);
    expect(proposal.actionId).toBeTruthy();

    const pending = store.agent_pending_actions![0]!;
    expect(pending).toMatchObject({
      user_id: MANAGER,
      tool_name: CONFIRM_TOUR_INQUIRY_TOOL,
      status: "proposed",
    });
    expect(pending.input).toMatchObject({ inquiryId: "inq_book", start: win.start, end: win.end });
    // Async approval expiry is well beyond a live chat turn's 15 minutes.
    expect(new Date(String(pending.expires_at)).getTime()).toBeGreaterThan(Date.now() + 60 * 60_000);

    // Approve through the SAME confirm gate the assistant uses.
    const result = await runConfirmedPendingAction(managerCtx(db), proposal.actionId!);
    expect(result.ok).toBe(true);

    // The tour is booked: a planned event exists for this inquiry...
    const planned = store.portal_schedule_records!.find((r) => r.id === PLANNED_RECORD_ID)!;
    const plannedPayload = (planned.row_data as { payload: Row[] }).payload;
    expect(plannedPayload.some((e) => e.kind === "tour" && e.sourceInquiryId === "inq_book")).toBe(true);

    // ...and the pending inquiry was removed from the inquiries record.
    const inquiries = store.portal_schedule_records!.find((r) => r.id === INQUIRIES_RECORD_ID)!;
    const inqPayload = (inquiries.row_data as { payload: Row[] }).payload;
    expect(inqPayload.some((i) => i.id === "inq_book")).toBe(false);

    // The tenant was notified through the existing path.
    expect(notifyTenantTourConfirmed).toHaveBeenCalledTimes(1);

    // Replaying the same approval is a no-op.
    const replay = await runConfirmedPendingAction(managerCtx(db), proposal.actionId!);
    expect(replay.ok).toBe(false);
  });

  it("does not propose twice for the same inquiry while one is open", async () => {
    const win = futureWindow(3, 20);
    const store: Record<string, Row[]> = {
      portal_schedule_records: [publishedAvailabilityRow([win.slotKey]), inquiriesRecord([tourInquiry("inq_dup", win)])],
      agent_pending_actions: [],
    };
    const db = makeDb(store);
    const first = await proposeTourConfirmation(db, { inquiry: tourInquiry("inq_dup", win), managerUserId: MANAGER, requestedWindows: [win] });
    expect(first.proposed).toBe(true);
    const second = await proposeTourConfirmation(db, { inquiry: tourInquiry("inq_dup", win), managerUserId: MANAGER, requestedWindows: [win] });
    expect(second).toMatchObject({ proposed: false, reason: "already_proposed" });
    expect(store.agent_pending_actions).toHaveLength(1);
  });

  it("does not propose when no slot matches", async () => {
    const win = futureWindow(3, 20);
    // Same reason as "returns null when nothing matches": publish the day but
    // not the hour, because an empty list opts the day into the 9-5 default.
    const store: Record<string, Row[]> = {
      portal_schedule_records: [
        publishedAvailabilityRow([futureWindow(3, 22).slotKey]),
        inquiriesRecord([tourInquiry("inq_none", win)]),
      ],
      agent_pending_actions: [],
    };
    const db = makeDb(store);
    const res = await proposeTourConfirmation(db, { inquiry: tourInquiry("inq_none", win), managerUserId: MANAGER, requestedWindows: [win] });
    expect(res).toMatchObject({ proposed: false, reason: "no_slot" });
    expect(store.agent_pending_actions).toHaveLength(0);
  });
});

describe("proposeTourConfirmation → discard", () => {
  it("discarding denies the proposal — nothing books, no tenant notification", async () => {
    const win = futureWindow(3, 20);
    const store: Record<string, Row[]> = {
      portal_schedule_records: [publishedAvailabilityRow([win.slotKey]), inquiriesRecord([tourInquiry("inq_discard", win)])],
      agent_pending_actions: [],
    };
    const db = makeDb(store);
    const ctx = managerCtx(db);

    const proposal = await proposeTourConfirmation(db, { inquiry: tourInquiry("inq_discard", win), managerUserId: MANAGER, requestedWindows: [win] });
    expect(proposal.proposed).toBe(true);

    const denied = await denyPendingAction(ctx, proposal.actionId!);
    expect(denied).toBeTruthy();
    expect(store.agent_pending_actions![0]).toMatchObject({ status: "denied" });

    // No planned tour was created, and the inquiry is untouched.
    expect(store.portal_schedule_records!.find((r) => r.id === PLANNED_RECORD_ID)).toBeUndefined();
    const inquiries = store.portal_schedule_records!.find((r) => r.id === INQUIRIES_RECORD_ID)!;
    expect((inquiries.row_data as { payload: Row[] }).payload.some((i) => i.id === "inq_discard")).toBe(true);
    expect(notifyTenantTourConfirmed).not.toHaveBeenCalled();

    // A discarded proposal can no longer be approved, and is gone from the queue.
    const approveAfterDiscard = await runConfirmedPendingAction(ctx, proposal.actionId!);
    expect(approveAfterDiscard.ok).toBe(false);
    const open = await listProposedActionsForUser(db, { userId: MANAGER, toolName: CONFIRM_TOUR_INQUIRY_TOOL });
    expect(open).toHaveLength(0);
  });
});
