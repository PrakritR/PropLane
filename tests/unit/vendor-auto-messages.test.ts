/**
 * comms-safety-0929 Part C: the two moments a vendor used to hear nothing about
 * (a new service offered to the preferred vendor, a vendor assigned to a
 * service) plus a task assigned to a vendor. Pure copy, delivery keys,
 * suppression, and the emit helpers against a fake database.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

const { workOrderEventMock, emitActionEventMock, sendOffersMock } = vi.hoisted(() => ({
  workOrderEventMock: vi.fn(),
  emitActionEventMock: vi.fn(),
  sendOffersMock: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/action-events.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/action-events.server")>()),
  emitActionEvent: (...args: unknown[]) => emitActionEventMock(...args),
}));
vi.mock("@/lib/work-order-offers.server", () => ({
  sendWorkOrderVendorOffers: (...args: unknown[]) => sendOffersMock(...args),
}));
vi.mock("@/lib/work-order-events.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/work-order-events.server")>()),
  workOrderEvent: (...args: unknown[]) => workOrderEventMock(...args),
  managerSender: async (_db: unknown, userId: string) => ({ userId, email: "mgr@seattle.test", name: "Seattle Homes" }),
}));
vi.mock("@/lib/app-url", () => ({ resolveEmailLinkBaseUrl: () => "https://app.proplane.test" }));

import {
  renderVendorTaskAssigned,
  renderWorkOrderEvent,
  vendorAssignedEventId,
} from "@/lib/work-order-events.server";
import {
  emitVendorAssigned,
  emitVendorTaskAssigned,
  offerNewServiceToPreferredVendor,
  preferenceTradesForCategory,
  vendorAssignmentAlreadyAnnounced,
} from "@/lib/work-order-vendor-messages.server";
import { vendorQuietHoursDeferral, vendorTopicForEvent } from "@/lib/vendor-notification-settings";
import { AUTOMATED_MESSAGE_CATALOG } from "@/lib/automated-messages-settings";
import { losAngelesHour } from "@/lib/reminders/rules";

type Row = Record<string, unknown>;

/** A tiny chainable fake: select/eq/in/order filters over in-memory rows. */
function fakeDb(tables: Record<string, Row[]>) {
  const from = (table: string) => {
    const filters: Array<(row: Row) => boolean> = [];
    const rows = () => (tables[table] ??= []);
    const matched = () => rows().filter((row) => filters.every((f) => f(row)));
    const q: Record<string, unknown> = {
      select: () => q,
      eq: (col: string, val: unknown) => (filters.push((r) => r[col] === val), q),
      in: (col: string, vals: unknown[]) => (filters.push((r) => vals.includes(r[col])), q),
      order: () => q,
      maybeSingle: () => Promise.resolve({ data: matched()[0] ?? null, error: null }),
      then: (resolve: (v: { data: Row[]; error: null }) => unknown) =>
        Promise.resolve({ data: matched(), error: null }).then(resolve),
    };
    return q;
  };
  return { from } as unknown as SupabaseClient;
}

const vendorRecord = (id = "vd-1", extra: Row = {}) => ({
  id,
  manager_user_id: "mgr-1",
  vendor_user_id: "vendor-user-1",
  row_data: { name: "North Plumbing", email: "north@vendor.test", trade: "Plumbing", ...extra },
});

const row = {
  reference: "SRV-1042",
  title: "Leaking sink",
  propertyName: "5257 Brooklyn Ave NE",
  unit: "Unit B",
  priority: "Medium" as const,
  scheduled: "",
  propertyId: "prop-1",
};

beforeEach(() => {
  vi.clearAllMocks();
  workOrderEventMock.mockResolvedValue({ eventId: "x", duplicate: false, delivered: 1, deferred: 0, failed: 0 });
  emitActionEventMock.mockResolvedValue({ eventId: "x", duplicate: false, delivered: 1, submitted: 0, deferred: 0, failed: 0 });
  sendOffersMock.mockResolvedValue({ ok: true, sent: ["vd-1"], skipped: [] });
});

describe("vendor copy: facts only, and it says service", () => {
  const facts = {
    reference: "SRV-1042",
    title: "Leaking sink",
    propertyLabel: "5257 Brooklyn Ave NE · Unit B",
    emergency: true,
    scheduledFor: "Thu, Sep 18 at 10:00 AM",
    expiresLabel: "Thu, Sep 18 at 4:00 PM",
    url: "https://app.proplane.test/vendor/work-orders",
    // Facts the vendor must NOT receive before accepting.
    residentName: "Alex Resident",
    residentContact: "Alex · (206) 555-0142",
    accessInstructions: "Gate code 4471",
  };

  it("new service offer: house, title, emergency, expiry and a link; no resident name, phone or access code", () => {
    const text = renderWorkOrderEvent("vendor_new_service", "vendor", facts)!.text;
    expect(text).toContain("New service offered to you at 5257 Brooklyn Ave NE · Unit B");
    expect(text).toContain("Leaking sink");
    expect(text).toContain("Emergency.");
    expect(text).toContain("Expires Thu, Sep 18 at 4:00 PM");
    expect(text).toContain("https://app.proplane.test/vendor/work-orders");
    expect(text).not.toMatch(/work order/i);
    expect(text).not.toContain("Alex");
    expect(text).not.toContain("555-0142");
    expect(text).not.toContain("4471");
  });

  it("assigned: 'You were assigned', visit time only when there is one, no resident facts", () => {
    const text = renderWorkOrderEvent("vendor_assigned", "vendor", facts)!.text;
    expect(text).toContain("You were assigned “Leaking sink” at 5257 Brooklyn Ave NE · Unit B");
    expect(text).toContain("Visit: Thu, Sep 18 at 10:00 AM.");
    expect(text).not.toMatch(/work order/i);
    expect(text).not.toContain("Alex");
    expect(text).not.toContain("4471");
    const unscheduled = renderWorkOrderEvent("vendor_assigned", "vendor", { ...facts, scheduledFor: undefined, emergency: false })!.text;
    expect(unscheduled).not.toContain("Visit:");
    expect(unscheduled).not.toContain("Emergency.");
  });

  it("falls back to 'Service', never 'Work order', when reference and title are blank", () => {
    const text = renderWorkOrderEvent("vendor_assigned", "vendor", { reference: "", title: "" })!.text;
    expect(text).toContain("Service: You were assigned “Service”");
    expect(text).not.toMatch(/work order/i);
  });

  it("only the vendor hears 'assigned'; the manager hears the preferred-vendor offer", () => {
    expect(renderWorkOrderEvent("vendor_assigned", "manager", facts)).toBeNull();
    expect(renderWorkOrderEvent("vendor_assigned", "resident", facts)).toBeNull();
    expect(renderWorkOrderEvent("vendor_new_service", "resident", facts)).toBeNull();
    expect(renderWorkOrderEvent("vendor_new_service", "manager", { ...facts, vendorName: "North Plumbing" })!.text).toContain(
      "offered to your preferred vendor North Plumbing",
    );
  });

  it("task: 'New task from <manager>' with house, due time and a link", () => {
    const rendered = renderVendorTaskAssigned({
      managerName: "Seattle Homes",
      title: "Replace smoke detector",
      propertyLabel: "5257 Brooklyn Ave NE",
      dueLabel: "Thu, Sep 18, 4:00 PM",
      url: "https://app.proplane.test/vendor/work-orders/pending",
    });
    expect(rendered.text).toBe(
      "New task from Seattle Homes: “Replace smoke detector” at 5257 Brooklyn Ave NE. Due Thu, Sep 18, 4:00 PM. Open it: https://app.proplane.test/vendor/work-orders/pending",
    );
    expect(rendered.subject).toBe("New task · Replace smoke detector");
  });

  it("is in the catalogue and files under the right vendor topics", () => {
    const keys = AUTOMATED_MESSAGE_CATALOG.map((e) => `${e.domain}:${e.event}`);
    expect(keys).toEqual(expect.arrayContaining(["work_order:vendor_new_service", "work_order:vendor_assigned", "task:task_assigned_vendor"]));
    expect(vendorTopicForEvent("work_order", "vendor_new_service")).toBe("offers");
    expect(vendorTopicForEvent("work_order", "vendor_assigned")).toBe("schedule");
    expect(vendorTopicForEvent("task", "task_assigned_vendor")).toBe("schedule");
  });
});

describe("delivery key and the duplicate guard", () => {
  it("one key per assignment: a retry is identical, a later reassignment differs", () => {
    const first = vendorAssignedEventId("wo-1", "vd-1", "2026-09-29T10:00:00.000Z");
    expect(first).toBe("wo-1:vendor_assigned:vd-1:2026-09-29T10:00:00.000Z");
    expect(vendorAssignedEventId("wo-1", "vd-1", "2026-09-29T10:00:00.000Z")).toBe(first);
    expect(vendorAssignedEventId("wo-1", "vd-1", "2026-09-30T09:00:00.000Z")).not.toBe(first);
    expect(vendorAssignedEventId("wo-1", "vd-2", "2026-09-29T10:00:00.000Z")).not.toBe(first);
  });

  it("an accepted or scheduled event at/after the assignment already told the vendor", () => {
    const at = "2026-09-29T10:00:00.000Z";
    expect(vendorAssignmentAlreadyAnnounced([{ event_type: "scheduled", occurred_at: "2026-09-29T10:00:01.000Z" }], at)).toBe(true);
    expect(vendorAssignmentAlreadyAnnounced([{ event_type: "accepted", occurred_at: at }], at)).toBe(true);
    // An EARLIER vendor's accept does not stand in for this assignment.
    expect(vendorAssignmentAlreadyAnnounced([{ event_type: "accepted", occurred_at: "2026-09-28T10:00:00.000Z" }], at)).toBe(false);
    expect(vendorAssignmentAlreadyAnnounced([{ event_type: "vendor_offered", occurred_at: "2026-09-29T11:00:00.000Z" }], at)).toBe(false);
    expect(vendorAssignmentAlreadyAnnounced([], at)).toBe(false);
  });
});

describe("emitVendorAssigned", () => {
  const assignedAt = "2026-09-29T10:00:00.000Z";
  const baseInput = { workOrderId: "wo-1", managerUserId: "mgr-1", row, vendorDirectoryId: "vd-1", assignedAt };

  it("sends one vendor-only message as the manager with the stable key", async () => {
    const db = fakeDb({ manager_vendor_records: [vendorRecord()], action_events: [] });
    const result = await emitVendorAssigned(db, baseInput);
    expect(result).toEqual({ sent: true, duplicate: false });
    expect(workOrderEventMock).toHaveBeenCalledTimes(1);
    const call = workOrderEventMock.mock.calls[0]![1] as Record<string, unknown> & { recipients: Array<{ rendered: { text: string }; audience: string; userId?: string }>; facts: Record<string, unknown>; eventId: string; event: string; senderUserId: string; senderEmail: string; category: string };
    expect(call.eventId).toBe(`wo-1:vendor_assigned:vd-1:${assignedAt}`);
    expect(call.event).toBe("vendor_assigned");
    expect(call.senderUserId).toBe("mgr-1");
    expect(call.senderEmail).toBe("mgr@seattle.test");
    expect(call.recipients).toEqual([{ audience: "vendor", userId: "vendor-user-1", email: "north@vendor.test" }]);
    expect(call.facts).toMatchObject({
      reference: "SRV-1042",
      title: "Leaking sink",
      propertyLabel: "5257 Brooklyn Ave NE · Unit B",
      emergency: false,
      url: "https://app.proplane.test/vendor/work-orders",
    });
    // Facts only: the resident is not in what the vendor is handed.
    expect(JSON.stringify(call.facts)).not.toMatch(/resident/i);
  });

  it("a retry re-emits the SAME key (the bus then sends nothing new)", async () => {
    const db = fakeDb({ manager_vendor_records: [vendorRecord()], action_events: [] });
    await emitVendorAssigned(db, baseInput);
    await emitVendorAssigned(db, baseInput);
    const keys = workOrderEventMock.mock.calls.map((c) => (c[1] as { eventId: string }).eventId);
    expect(new Set(keys).size).toBe(1);
  });

  it("a later reassignment carries a new key and does send", async () => {
    const db = fakeDb({ manager_vendor_records: [vendorRecord()], action_events: [] });
    await emitVendorAssigned(db, baseInput);
    await emitVendorAssigned(db, { ...baseInput, assignedAt: "2026-09-30T09:00:00.000Z" });
    const keys = workOrderEventMock.mock.calls.map((c) => (c[1] as { eventId: string }).eventId);
    expect(new Set(keys).size).toBe(2);
  });

  it("stands down when accepted/scheduled already went for this assignment", async () => {
    const db = fakeDb({
      manager_vendor_records: [vendorRecord()],
      action_events: [{ domain: "work_order", entity_id: "wo-1", event_type: "scheduled", occurred_at: "2026-09-29T10:00:05.000Z" }],
    });
    expect(await emitVendorAssigned(db, baseInput)).toEqual({ sent: false, reason: "suppressed_already_announced" });
    expect(workOrderEventMock).not.toHaveBeenCalled();
  });

  it("sends nothing for a vendor outside the manager's directory", async () => {
    const db = fakeDb({
      manager_vendor_records: [{ ...vendorRecord("vd-9"), manager_user_id: "someone-else" }],
      action_events: [],
    });
    expect(await emitVendorAssigned(db, { ...baseInput, vendorDirectoryId: "vd-9" })).toEqual({ sent: false, reason: "vendor_unavailable" });
    expect(workOrderEventMock).not.toHaveBeenCalled();
  });

  it("flags an emergency service so the vendor's emergency bypass applies", async () => {
    const db = fakeDb({ manager_vendor_records: [vendorRecord()], action_events: [] });
    await emitVendorAssigned(db, { ...baseInput, row: { ...row, priority: "Emergency" } });
    expect((workOrderEventMock.mock.calls[0]![1] as { facts: { emergency: boolean } }).facts.emergency).toBe(true);
  });
});

describe("emitVendorTaskAssigned", () => {
  const task = {
    id: "task-1",
    title: "Replace smoke detector",
    propertyTitle: "5257 Brooklyn Ave NE",
    propertyId: "prop-1",
    dueDate: "2026-09-18T23:00:00.000Z",
    completed: false,
    assignee: { type: "vendor" as const, id: "vd-1", name: "North Plumbing" },
    createdAt: "2026-09-17T00:00:00.000Z",
    updatedAt: "2026-09-17T00:00:00.000Z",
  };

  it("sends 'New task' as the manager under a key that includes the change time", async () => {
    const db = fakeDb({ manager_vendor_records: [vendorRecord()] });
    const result = await emitVendorTaskAssigned(db, { managerUserId: "mgr-1", task, changedAt: task.createdAt });
    expect(result).toEqual({ sent: true, duplicate: false });
    const call = emitActionEventMock.mock.calls[0]![1] as Record<string, unknown> & { recipients: Array<{ rendered: { text: string }; audience: string; userId?: string }>; facts: Record<string, unknown>; eventId: string; event: string; senderUserId: string; senderEmail: string; category: string };
    expect(call).toMatchObject({
      eventId: `task:task-1:task_assigned_vendor:vd-1:${task.createdAt}`,
      domain: "task",
      event: "task_assigned_vendor",
      senderUserId: "mgr-1",
      category: "maintenance",
    });
    expect(call.recipients[0]).toMatchObject({ audience: "vendor", userId: "vendor-user-1" });
    expect(call.recipients[0].rendered.text).toContain("New task from Seattle Homes");
  });

  it("a team-assigned task sends nothing", async () => {
    const db = fakeDb({ manager_vendor_records: [vendorRecord()] });
    const result = await emitVendorTaskAssigned(db, {
      managerUserId: "mgr-1",
      task: { ...task, assignee: { type: "team", id: "mgr-2", name: "Dana" } },
      changedAt: task.createdAt,
    });
    expect(result).toEqual({ sent: false, reason: "not_a_vendor_task" });
    expect(emitActionEventMock).not.toHaveBeenCalled();
  });
});

describe("offerNewServiceToPreferredVendor (D3)", () => {
  const openRow = {
    ...row,
    id: "wo-1",
    bucket: "open",
    category: "plumbing",
    assignedPropertyId: "prop-1",
  };
  const tables = (over: Record<string, Row[]> = {}) => ({
    portal_work_order_records: [{ id: "wo-1", manager_user_id: "mgr-1", row_data: openRow }],
    manager_vendor_preferences: [
      { manager_user_id: "mgr-1", property_id: "prop-1", trade: "Plumbing", vendor_id: "vd-gone", priority: 0 },
      { manager_user_id: "mgr-1", property_id: "prop-1", trade: "Plumbing", vendor_id: "vd-1", priority: 1 },
    ],
    manager_vendor_records: [vendorRecord()],
    work_order_vendor_offers: [],
    ...over,
  });

  it("maps a work-order category to the trade labels the preferences are stored under", () => {
    expect(preferenceTradesForCategory("plumbing")).toEqual(["Plumbing"]);
    expect(preferenceTradesForCategory("general")).toEqual(["General maintenance"]);
    expect(preferenceTradesForCategory(undefined)).toEqual([]);
  });

  it("offers to the first preferred vendor still on the roster, as a new-service offer", async () => {
    const result = await offerNewServiceToPreferredVendor(fakeDb(tables()), { workOrderId: "wo-1" });
    expect(result).toEqual({ offered: true, vendorDirectoryId: "vd-1" });
    expect(sendOffersMock).toHaveBeenCalledTimes(1);
    const [, actor, body] = sendOffersMock.mock.calls[0]! as [unknown, Record<string, unknown>, Record<string, unknown>];
    expect(actor).toMatchObject({ userId: "mgr-1", role: "manager", admin: false });
    expect(body).toEqual({ workOrderId: "wo-1", vendorIds: ["vd-1"], marketplace: { enabled: false }, newService: true });
  });

  it("with no preferred vendor set, nobody is messaged", async () => {
    const result = await offerNewServiceToPreferredVendor(fakeDb(tables({ manager_vendor_preferences: [] })), { workOrderId: "wo-1" });
    expect(result).toEqual({ offered: false, reason: "no_preferred_vendor" });
    expect(sendOffersMock).not.toHaveBeenCalled();
  });

  it("a preference for a different house or trade does not count", async () => {
    const result = await offerNewServiceToPreferredVendor(
      fakeDb(
        tables({
          manager_vendor_preferences: [
            { manager_user_id: "mgr-1", property_id: "prop-2", trade: "Plumbing", vendor_id: "vd-1", priority: 0 },
            { manager_user_id: "mgr-1", property_id: "prop-1", trade: "Electrical", vendor_id: "vd-1", priority: 0 },
          ],
        }),
      ),
      { workOrderId: "wo-1" },
    );
    expect(result).toEqual({ offered: false, reason: "no_preferred_vendor" });
    expect(sendOffersMock).not.toHaveBeenCalled();
  });

  it("never re-offers a service the vendor already has an offer on", async () => {
    const result = await offerNewServiceToPreferredVendor(
      fakeDb(tables({ work_order_vendor_offers: [{ work_order_id: "wo-1", vendor_directory_id: "vd-1" }] })),
      { workOrderId: "wo-1" },
    );
    expect(result).toEqual({ offered: false, reason: "already_offered" });
    expect(sendOffersMock).not.toHaveBeenCalled();
  });

  it("skips a service that is not an open, unassigned resident filing", async () => {
    for (const patch of [{ vendorId: "vd-5" }, { selfAssigned: true }, { managerInitiated: true }, { bucket: "scheduled" }, { biddingOpen: true }]) {
      const result = await offerNewServiceToPreferredVendor(
        fakeDb(tables({ portal_work_order_records: [{ id: "wo-1", manager_user_id: "mgr-1", row_data: { ...openRow, ...patch } }] })),
        { workOrderId: "wo-1" },
      );
      expect(result).toEqual({ offered: false, reason: "not_eligible" });
    }
    expect(sendOffersMock).not.toHaveBeenCalled();
  });
});

describe("a vendor's own quiet hours: the text waits until 7:00, the rest goes at once", () => {
  const defaults = { quietHours: { enabled: true, startHour: 20, endHour: 7 }, emergencyBypassQuietHours: true };

  it("8:05pm Pacific defers the text to 7:00am Pacific", () => {
    const now = new Date("2026-09-30T03:05:00.000Z"); // 8:05pm PDT
    const until = vendorQuietHoursDeferral(defaults, now, losAngelesHour);
    expect(until).toBe("2026-09-30T14:00:00.000Z"); // 7:00am PDT
  });

  it("daytime is not deferred", () => {
    expect(vendorQuietHoursDeferral(defaults, new Date("2026-09-30T19:00:00.000Z"), losAngelesHour)).toBeNull();
  });

  it("an emergency skips the wait only when the vendor kept the bypass on", () => {
    const now = new Date("2026-09-30T03:05:00.000Z");
    expect(vendorQuietHoursDeferral(defaults, now, losAngelesHour, { urgent: true })).toBeNull();
    expect(vendorQuietHoursDeferral({ ...defaults, emergencyBypassQuietHours: false }, now, losAngelesHour, { urgent: true })).toBe(
      "2026-09-30T14:00:00.000Z",
    );
  });

  it("quiet hours switched off never defer", () => {
    expect(
      vendorQuietHoursDeferral({ ...defaults, quietHours: { ...defaults.quietHours, enabled: false } }, new Date("2026-09-30T03:05:00.000Z"), losAngelesHour),
    ).toBeNull();
  });
});
