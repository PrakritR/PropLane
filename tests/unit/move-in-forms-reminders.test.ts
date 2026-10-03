import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const emitted = vi.hoisted(() => ({ calls: [] as { event: string; id: string; nonce?: string }[] }));
vi.mock("@/lib/move-in-forms/move-in-form-events.server", () => ({
  emitMoveInFormEvent: vi.fn(async (_db: unknown, input: { event: string; row: { id: string }; nonce?: string }) => {
    emitted.calls.push({ event: input.event, id: input.row.id, nonce: input.nonce });
  }),
}));

import { moveInFormReminderKindFor, sweepMoveInFormReminders } from "@/lib/reminders/subjects/move-in-forms.server";

type Row = Record<string, unknown>;
let forms: Row[];
let properties: Row[];

function builder(table: string) {
  const filters: ((row: Row) => boolean)[] = [];
  let patch: Row | undefined;
  const value = (row: Row, key: string): unknown => {
    const [column, path] = key.split("->>");
    const cell = row[column!];
    return path ? ((cell as Record<string, unknown> | null)?.[path] ?? null) : cell;
  };
  const rows = () => (table === "resident_move_in_forms" ? forms : properties);
  const run = () => {
    const matched = rows().filter((row) => filters.every((f) => f(row)));
    if (patch) for (const row of matched) Object.assign(row, patch);
    return { data: structuredClone(matched), error: null };
  };
  const q: Record<string, unknown> = {
    select: () => q, order: () => q, range: () => q,
    eq: (key: string, v: unknown) => { filters.push((row) => value(row, key) === v); return q; },
    in: (key: string, v: unknown[]) => { filters.push((row) => v.includes(value(row, key))); return q; },
    is: (key: string, v: unknown) => { filters.push((row) => (value(row, key) ?? null) === v); return q; },
    gte: (key: string, v: string) => { filters.push((row) => String(value(row, key)) >= v); return q; },
    lte: (key: string, v: string) => { filters.push((row) => String(value(row, key)) <= v); return q; },
    update: (v: Row) => { patch = v; return q; },
    maybeSingle: async () => { const r = run(); return { error: null, data: r.data[0] ?? null }; },
    then: (resolve: (v: ReturnType<typeof run>) => unknown) => Promise.resolve(run()).then(resolve),
  };
  return q;
}
const db = { from: builder } as never;

// 2026-10-10 12:00 Pacific is 19:00Z. A form due that day ends at 23:59:59 Pacific (06:59:59Z the next day).
const DUE = "2026-10-11T06:59:59.000Z";
const form = (overrides: Row = {}): Row => ({
  id: "f1", manager_user_id: "owner", property_id: "home", property_label: "12 Elm", room_label: "Room 1",
  resident_name: "A", resident_email: "a@example.test", resident_user_id: null, form_name: "Checklist",
  status: "sent", due_at: DUE, sent_at: "2026-10-01T18:00:00.000Z", reminders_sent: {}, reminded_at: null, ...overrides,
});
const at = (iso: string) => new Date(iso);

beforeEach(() => {
  emitted.calls = [];
  forms = [form()];
  properties = [{ id: "home", settings: null }];
});

describe("which reminder is due", () => {
  it("follows the property's Remind residents choice", () => {
    expect(moveInFormReminderKindFor("before-and-due", "2026-10-08", "2026-10-10")).toBe("before");
    expect(moveInFormReminderKindFor("before-and-due", "2026-10-10", "2026-10-10")).toBe("due");
    expect(moveInFormReminderKindFor("before-and-due", "2026-10-09", "2026-10-10")).toBeNull();
    expect(moveInFormReminderKindFor("due-only", "2026-10-08", "2026-10-10")).toBeNull();
    expect(moveInFormReminderKindFor("due-only", "2026-10-10", "2026-10-10")).toBe("due");
    expect(moveInFormReminderKindFor("never", "2026-10-10", "2026-10-10")).toBeNull();
  });
});

describe("sweepMoveInFormReminders", () => {
  it("sends the early reminder two days before the due date and the due reminder on the day, each once", async () => {
    expect(await sweepMoveInFormReminders(db, at("2026-10-08T19:00:00Z"))).toBe(1);
    expect(emitted.calls).toEqual([{ event: "reminder", id: "f1", nonce: "auto-before" }]);
    expect((forms[0]!.reminders_sent as Record<string, string>).before).toBeTruthy();
    // A re-run the same day sends nothing more.
    expect(await sweepMoveInFormReminders(db, at("2026-10-08T21:00:00Z"))).toBe(0);
    expect(await sweepMoveInFormReminders(db, at("2026-10-09T19:00:00Z"))).toBe(0);
    expect(await sweepMoveInFormReminders(db, at("2026-10-10T19:00:00Z"))).toBe(1);
    expect(await sweepMoveInFormReminders(db, at("2026-10-10T23:00:00Z"))).toBe(0);
    expect(emitted.calls.map((call) => call.nonce)).toEqual(["auto-before", "auto-due"]);
    expect(forms[0]!.reminded_at).toBeTruthy();
  });

  it("due-only skips the early reminder; never sends nothing", async () => {
    properties[0]!.settings = { remind: "due-only", notifyOnSubmit: "assistant" };
    expect(await sweepMoveInFormReminders(db, at("2026-10-08T19:00:00Z"))).toBe(0);
    expect(await sweepMoveInFormReminders(db, at("2026-10-10T19:00:00Z"))).toBe(1);
    forms = [form()];
    emitted.calls = [];
    properties[0]!.settings = { remind: "never", notifyOnSubmit: "assistant" };
    expect(await sweepMoveInFormReminders(db, at("2026-10-08T19:00:00Z"))).toBe(0);
    expect(await sweepMoveInFormReminders(db, at("2026-10-10T19:00:00Z"))).toBe(0);
    expect(emitted.calls).toEqual([]);
  });

  it("never reminds a submitted or cancelled form, or one sent the same day", async () => {
    forms = [form({ id: "s", status: "submitted" }), form({ id: "c", status: "cancelled" }), form({ id: "n", sent_at: "2026-10-10T15:00:00.000Z" })];
    expect(await sweepMoveInFormReminders(db, at("2026-10-10T19:00:00Z"))).toBe(0);
    expect(emitted.calls).toEqual([]);
  });

  it("two overlapping runs deliver one reminder", async () => {
    const results = await Promise.all([
      sweepMoveInFormReminders(db, at("2026-10-10T19:00:00Z")),
      sweepMoveInFormReminders(db, at("2026-10-10T19:00:00Z")),
    ]);
    expect(results.reduce((a, b) => a + b, 0)).toBe(1);
    expect(emitted.calls).toHaveLength(1);
  });
});
