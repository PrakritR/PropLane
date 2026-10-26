import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  INBOX_EVENT_KINDS,
  bubbleEventFields,
  buildInboxEventStamp,
  inboxEventAction,
  inboxEventKindFor,
  inboxEventTitleFor,
  rootEventFieldsFromTurn,
  turnEventFieldsFromRoot,
} from "@/lib/inbox-event-card";

/**
 * A3 (stay chat). An automated turn carries `eventKind` and its card so the thread draws it as a card; a turn
 * with no stamp (every row written before this) is untouched. The kind comes from the action event, built from
 * stored facts only, for the RESIDENT copy only.
 */
describe("which events are cards", () => {
  it("maps the cards the plan names and nothing else", () => {
    expect(inboxEventKindFor("payment", "charge_created")).toBe("charge_created");
    expect(inboxEventKindFor("payment", "payment_received")).toBe("payment_received");
    expect(inboxEventKindFor("payment", "payment_failed")).toBe("payment_failed");
    expect(inboxEventKindFor("payment", "late_fee_applied")).toBe("late_fee_applied");
    expect(inboxEventKindFor("lease", "lease_sent")).toBe("lease_sent");
    expect(inboxEventKindFor("lease", "lease_signed")).toBe("lease_signed");
    expect(inboxEventKindFor("lease", "lease_signed_by_resident")).toBe("lease_signed_by_resident");
    expect(inboxEventKindFor("lease", "lease_countersigned")).toBe("lease_countersigned");
    expect(inboxEventKindFor("application", "application_approved")).toBe("application_approved");
    expect(inboxEventKindFor("move_in", "move_in_details")).toBe("move_in_details");
    expect(inboxEventKindFor("move_in", "room_assigned")).toBe("room_assigned");
    // Not cards: they keep the plain activity row.
    expect(inboxEventKindFor("payment", "payment_processing")).toBeNull();
    expect(inboxEventKindFor("payment", "payment_refunded")).toBeNull();
    expect(inboxEventKindFor("lease", "lease_voided")).toBeNull();
    expect(inboxEventKindFor("work_order", "completed")).toBeNull();
    // A name in the wrong domain is not a card either.
    expect(inboxEventKindFor("work_order", "lease_sent")).toBeNull();
    expect(inboxEventKindFor("lease", "charge_created")).toBeNull();
  });
});

describe("the stamp built for a resident delivery", () => {
  const payment = { title: "Rent", amountLabel: "$1,150.00", propertyLabel: "4709A 8th Ave", dueDateLabel: "Nov 1" };

  it("a rent charge reads as rent due, with the charge as the record", () => {
    const stamp = buildInboxEventStamp({ domain: "payment", event: "charge_created", audience: "resident", entityId: "chg-1", payload: payment });
    expect(stamp?.kind).toBe("charge_created");
    expect(stamp?.card).toEqual({ title: "Rent due Nov 1 · $1,150.00", fact: "4709A 8th Ave" });
    expect(stamp?.recordRef).toEqual({ kind: "payment", id: "chg-1", label: "Rent" });
  });

  it.each([
    ["payment", "payment_received", "Rent paid", "payment"],
    ["payment", "payment_failed", "Rent payment failed", "payment"],
    ["payment", "late_fee_applied", "Late fee · $1,150.00", "payment"],
  ] as const)("%s %s", (domain, event, title, refKind) => {
    const stamp = buildInboxEventStamp({ domain, event, audience: "resident", entityId: "chg-1", payload: payment });
    expect(stamp?.kind).toBe(event);
    expect(stamp?.card.title).toBe(title);
    expect(stamp?.recordRef?.kind).toBe(refKind);
  });

  it.each([
    ["lease_sent", "Lease ready to sign"],
    ["lease_signed_by_resident", "You signed the lease"],
    ["lease_countersigned", "Your manager signed the lease"],
    ["lease_signed", "Lease signed"],
  ] as const)("lease %s", (event, title) => {
    const stamp = buildInboxEventStamp({ domain: "lease", event, audience: "resident", entityId: "lease-1", payload: { propertyLabel: "4709A 8th Ave" } });
    expect(stamp?.kind).toBe(event);
    expect(stamp?.card).toEqual({ title, fact: "4709A 8th Ave" });
    expect(stamp?.recordRef).toEqual({ kind: "lease", id: "lease-1", label: "4709A 8th Ave" });
  });

  it("an approved application names the application", () => {
    const stamp = buildInboxEventStamp({ domain: "application", event: "application_approved", audience: "resident", entityId: "app-1", payload: { propertyLabel: "Cedar Court" } });
    expect(stamp?.kind).toBe("application_approved");
    expect(stamp?.recordRef).toEqual({ kind: "application", id: "app-1", label: "Cedar Court" });
  });

  it("move-in details and room assigned point at the home through the property ref", () => {
    const details = buildInboxEventStamp({
      domain: "move_in",
      event: "move_in_details",
      audience: "resident",
      entityId: "app-1",
      payload: { propertyId: "prop-1", propertyLabel: "4709A 8th Ave", cardFact: "Fri, Nov 1 after 3:00 pm · 4709A 8th Ave" },
    });
    expect(details?.card).toEqual({ title: "Move-in details", fact: "Fri, Nov 1 after 3:00 pm · 4709A 8th Ave" });
    expect(details?.recordRef).toEqual({ kind: "property", id: "prop-1", label: "4709A 8th Ave" });
    const room = buildInboxEventStamp({
      domain: "move_in",
      event: "room_assigned",
      audience: "resident",
      entityId: "app-1",
      payload: { propertyId: "prop-1", propertyLabel: "4709A 8th Ave", roomLabel: "Room 3" },
    });
    expect(room?.card.title).toBe("Room assigned: Room 3");
    expect(room?.recordRef?.kind).toBe("property");
  });

  it("only the resident copy is a card; manager, team and vendor copies are not", () => {
    for (const audience of ["manager", "team", "vendor"]) {
      expect(buildInboxEventStamp({ domain: "payment", event: "payment_received", audience, entityId: "chg-1", payload: payment })).toBeNull();
    }
  });

  it("a non-card event stamps nothing", () => {
    expect(buildInboxEventStamp({ domain: "payment", event: "payment_processing", audience: "resident", entityId: "chg-1", payload: payment })).toBeNull();
  });

  it("every kind in the vocabulary has a viewer action and a title for each viewer", () => {
    for (const kind of INBOX_EVENT_KINDS) {
      expect(inboxEventAction("resident", kind)?.href).toMatch(/^\/resident\//);
      expect(inboxEventAction("manager", kind)?.href).toMatch(/^\/portal\//);
      expect(inboxEventTitleFor("resident", kind, "T")).toBe("T");
    }
    expect(inboxEventTitleFor("manager", "move_in_details", "Move-in details")).toBe("Move-in details sent");
    expect(inboxEventAction("resident", "charge_created")?.label).toBe("Pay");
    expect(inboxEventAction("resident", "move_in_details")?.label).toBe("Open");
  });
});

describe("stamps round-trip through the root turn and the bubble", () => {
  const card = { title: "Lease signed", fact: "4709A" };
  const recordRef = { kind: "lease" as const, id: "lease-1", label: "4709A" };

  it("a turn's stamps become root stamps and back", () => {
    const root = rootEventFieldsFromTurn({ eventKind: "lease_signed", eventCard: card, recordRef, senderDisplayName: "Dev · Co-host" });
    expect(root).toEqual({ rootEventKind: "lease_signed", rootEventCard: card, rootEventRecordRef: recordRef, rootSenderDisplayName: "Dev · Co-host" });
    expect(turnEventFieldsFromRoot(root as unknown as Record<string, unknown>)).toEqual({
      eventKind: "lease_signed",
      eventCard: card,
      recordRef,
      senderDisplayName: "Dev · Co-host",
    });
  });

  it("a root with no stamps clears the previous root's (every key present, undefined)", () => {
    const root = rootEventFieldsFromTurn({});
    expect(Object.keys(root).sort()).toEqual(["rootEventCard", "rootEventKind", "rootEventRecordRef", "rootSenderDisplayName"]);
    expect(Object.values(root).every((value) => value === undefined)).toBe(true);
  });

  it("a bad kind or a card with no title is dropped, never guessed", () => {
    expect(bubbleEventFields({ eventKind: "made_up", eventCard: card })).toEqual({});
    expect(bubbleEventFields({ eventKind: "lease_signed", eventCard: { title: "  " } })).toEqual({});
    expect(bubbleEventFields({ eventKind: "lease_signed" })).toEqual({});
    expect(bubbleEventFields({ eventKind: "lease_signed", eventCard: card, recordRef })).toEqual({
      eventKind: "lease_signed",
      eventCard: card,
      eventRecordRef: recordRef,
    });
  });
});

// ---- the bus: every card event hands the delivery layer its kind and record ----------------------------------
const deliver = vi.fn(async () => ({ ok: true as const, recipientCount: 1 }));
vi.mock("@/lib/portal-inbox-delivery", () => ({
  deliverPortalInboxMessage: (...args: unknown[]) => deliver(...(args as [])),
}));

type Row = Record<string, unknown> & { id: string };

function fakeBusDb(): SupabaseClient {
  const tables: Record<string, Row[]> = { action_events: [], action_event_deliveries: [] };
  let sequence = 0;
  const from = (table: string) => {
    const filters: Array<(row: Row) => boolean> = [];
    const rows = () => tables[table] ?? (tables[table] = []);
    let mutation: Record<string, unknown> | null = null;
    let upserted: Row | null = null;
    let duplicateIgnored = false;
    let countOnly = false;
    const matched = () => rows().filter((row) => filters.every((filter) => filter(row)));
    const q = {
      select(_c?: string, opts?: { head?: boolean }) { countOnly = opts?.head === true; return q; },
      eq(column: string, value: unknown) { filters.push((row) => row[column] === value); return q; },
      gte(column: string, value: string) { filters.push((row) => String(row[column] ?? "") >= value); return q; },
      lte(column: string, value: string) { filters.push((row) => String(row[column] ?? "") <= value); return q; },
      in(column: string, values: unknown[]) { filters.push((row) => values.includes(row[column])); return q; },
      order() { return q; },
      limit(n: number) { return Promise.resolve({ data: matched().slice(0, n), error: null }); },
      upsert(payload: Record<string, unknown>, opts?: { onConflict?: string; ignoreDuplicates?: boolean }) {
        const keys = opts?.onConflict?.split(",") ?? ["id"];
        const existing = rows().find((row) => keys.every((key) => row[key] === payload[key]));
        if (existing && opts?.ignoreDuplicates) { upserted = null; duplicateIgnored = true; }
        else if (existing) upserted = Object.assign(existing, payload);
        else { upserted = { id: `${table}-${++sequence}`, created_at: new Date().toISOString(), attempts: 0, ...payload } as Row; rows().push(upserted); }
        return q;
      },
      update(payload: Record<string, unknown>) { mutation = payload; return q; },
      maybeSingle() {
        const selected = matched()[0] ?? null;
        if (mutation && selected) Object.assign(selected, mutation);
        return Promise.resolve({ data: duplicateIgnored ? null : upserted ?? selected, error: null });
      },
      then<T>(resolve: (value: { data: Row[]; error: null; count?: number }) => T) {
        const data = matched();
        if (mutation) for (const row of data) Object.assign(row, mutation);
        return Promise.resolve({ data, error: null, ...(countOnly ? { count: data.length } : {}) }).then(resolve);
      },
    };
    return q;
  };
  return { from } as unknown as SupabaseClient;
}

describe("the action-event bus hands the delivery layer the card", () => {
  beforeEach(() => deliver.mockClear());

  it.each([
    ["payment", "charge_created", "chg-9", { title: "Rent", amountLabel: "$1,150.00", propertyLabel: "4709A", dueDateLabel: "Nov 1" }, "payment"],
    ["payment", "payment_received", "chg-9", { title: "Rent", amountLabel: "$1,150.00" }, "payment"],
    ["payment", "payment_failed", "chg-9", { title: "Rent", amountLabel: "$1,150.00" }, "payment"],
    ["payment", "late_fee_applied", "chg-9", { title: "Rent", amountLabel: "$50.00" }, "payment"],
    ["lease", "lease_sent", "lease-9", { propertyLabel: "4709A" }, "lease"],
    ["lease", "lease_signed", "lease-9", { propertyLabel: "4709A" }, "lease"],
    ["lease", "lease_signed_by_resident", "lease-9", { propertyLabel: "4709A" }, "lease"],
    ["lease", "lease_countersigned", "lease-9", { propertyLabel: "4709A" }, "lease"],
    ["application", "application_approved", "app-9", { propertyLabel: "4709A" }, "application"],
    ["move_in", "move_in_details", "app-9", { propertyId: "prop-1", propertyLabel: "4709A", cardFact: "Nov 1" }, "property"],
    ["move_in", "room_assigned", "app-9", { propertyId: "prop-1", propertyLabel: "4709A", roomLabel: "Room 3" }, "property"],
  ] as const)("%s %s", async (domain, event, entityId, payload, refKind) => {
    const { emitActionEvent } = await import("@/lib/action-events.server");
    await emitActionEvent(fakeBusDb(), {
      eventId: `${entityId}:${event}`,
      domain,
      event,
      managerUserId: "mgr-1",
      entityId,
      category: "payments",
      senderUserId: "mgr-1",
      senderEmail: "mgr@example.com",
      payload: { ...payload },
      recipients: [{ audience: "resident", userId: "res-1", rendered: { subject: "S", text: "Body." } }],
      now: new Date("2026-09-04T19:00:00.000Z"),
    });
    expect(deliver).toHaveBeenCalledTimes(1);
    const sent = deliver.mock.calls[0]?.[1] as { event?: { kind: string; card: { title: string }; recordRef?: { kind: string; id: string } } };
    expect(sent.event?.kind).toBe(event);
    expect(sent.event?.card.title).toBeTruthy();
    expect(sent.event?.recordRef?.kind).toBe(refKind);
  });

  it("a manager copy and a non-card event carry no stamp", async () => {
    const { emitActionEvent } = await import("@/lib/action-events.server");
    await emitActionEvent(fakeBusDb(), {
      eventId: "chg-9:payment_processing",
      domain: "payment",
      event: "payment_processing",
      managerUserId: "mgr-1",
      entityId: "chg-9",
      category: "payments",
      senderUserId: "mgr-1",
      senderEmail: "mgr@example.com",
      recipients: [{ audience: "resident", userId: "res-1", rendered: { subject: "S", text: "Body." } }],
      now: new Date("2026-09-04T19:00:00.000Z"),
    });
    expect((deliver.mock.calls[0]?.[1] as { event?: unknown }).event).toBeUndefined();
  });
});
