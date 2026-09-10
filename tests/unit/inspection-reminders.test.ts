import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { DEFAULT_REMINDER_SETTINGS } from "@/lib/reminders/rules";
import type { ReminderQueueRow } from "@/lib/reminders/queue.server";
import { inspectionReminderIsCurrent, sweepInspectionReminders } from "@/lib/reminders/subjects/inspections.server";
import { createRoomInspectionDocument } from "@/lib/inspections/room-template";
import { reportFixture } from "../helpers/inspection-fixture";

vi.mock("@/lib/app-url", () => ({ resolveEmailLinkBaseUrl: () => "https://example.test" }));
vi.mock("@/lib/reminders/settings.server", () => ({ loadReminderSettingsForManagers: async () => new Map([["owner", DEFAULT_REMINDER_SETTINGS]]) }));
vi.mock("@/lib/reminders/manager-recipients.server", () => ({ loadManagerReminderRecipients: async () => new Map([["owner", { email: "owner@example.test" }]]) }));

type Row = Record<string, unknown>;
let application: Row;
let reports: Row[];
let queued: Map<string, Row>;
const rooms = [{ id: "room-a", name: "Room A", moveInInspectionRequired: true }];

const now = new Date("2026-09-06T12:00:00Z");

// Exercise the actual queue materializer and its insert-ignore dedupe behavior.
const db = { from(table: string) {
  const predicates: ((row: Row) => boolean)[] = [];
  let start = 0; let end = Infinity;
  const source = () => table === "manager_application_records" ? [application]
    : table === "resident_inspections" ? reports
      : [{ id: "home", manager_user_id: "owner", rooms }];
  const run = () => ({ data: structuredClone(source().filter(row => predicates.every(p => p(row))).slice(start, end + 1)), error: null });
  const query = {
    select: () => query, order: () => query,
    eq: (key: string, value: unknown) => { predicates.push(row => key === "row_data->>bucket" ? (row.row_data as Row).bucket === value : row[key] === value); return query; },
    in: (key: string, values: unknown[]) => { predicates.push(row => values.includes(row[key])); return query; },
    range: (from: number, to: number) => { start = from; end = to; return query; },
    maybeSingle: async () => ({ ...run(), data: run().data[0] ?? null }),
    upsert: async (rows: Row[], options: { ignoreDuplicates: boolean }) => {
      for (const row of rows) if (!options.ignoreDuplicates || !queued.has(String(row.dedupe_key))) queued.set(String(row.dedupe_key), row);
      return { error: null };
    },
    then: (resolve: (value: ReturnType<typeof run>) => unknown) => Promise.resolve(run()).then(resolve),
  };
  return query;
} } as unknown as SupabaseClient;

function setMoveDate(date: string) {
  application.manual_start = date;
  ((application.row_data as Row).manualResidentDetails as Row).moveInDate = date;
}
function asQueueRow(row: Row): ReminderQueueRow {
  return { id: "queued", managerUserId: String(row.manager_user_id), kind: row.kind as ReminderQueueRow["kind"], subjectId: String(row.subject_id), leadMinutes: Number(row.lead_minutes), recipientEmail: String(row.recipient_email), recipientRole: row.recipient_role as ReminderQueueRow["recipientRole"], sendAt: String(row.send_at), attempts: 0, payload: row.payload as Row };
}
function roomReport(photoBy?: "manager" | "resident") {
  const document = createRoomInspectionDocument({ assignment: "home::room-a", label: "Room A", furnished: false, privateBathroom: false });
  document.areas[0].items[0].resident.notes = "Existing mark beside door";
  if (photoBy) document.areas[0].items[0][photoBy].photos.push({ id: "photo", path: "private/photo.jpg", uploadedBy: photoBy, uploadedAt: now.toISOString() });
  return reportFixture({ room_label: "Room A", document, updated_at: now.toISOString() }) as unknown as Row;
}

beforeEach(() => {
  reports = []; queued = new Map(); rooms[0]!.moveInInspectionRequired = true;
  application = { id: "AXIS-TEST", manager_user_id: "owner", resident_email: "resident@example.test", property_id: "home", assigned_property_id: "home",
    placement: "", manual_room: "Room A", bucket: "approved", withdrawn: null,
    row_data: { bucket: "approved", assignedRoomChoice: "", manualResidentDetails: { roomNumber: "Room A" } },
  };
  setMoveDate("2026-09-10");
});

describe("inspection reminder lifecycle", () => {
  it("creates replacement reminders after the move date changes and rejects the old anchor", async () => {
    await sweepInspectionReminders(db, now);
    const first = [...queued.values()];
    expect(first.length).toBeGreaterThan(0);
    setMoveDate("2026-09-15");
    await sweepInspectionReminders(db, now);
    expect(queued.size).toBe(first.length * 2);
    expect(new Set([...queued.values()].map(row => row.subject_id)).size).toBe(2);
    expect(await inspectionReminderIsCurrent(db, asQueueRow(first[0]))).toBe(false);
    const replacement = [...queued.values()].find(row => (row.payload as Row).anchorIso === "2026-09-15T19:00:00.000Z")!;
    expect(await inspectionReminderIsCurrent(db, asQueueRow(replacement))).toBe(true);
  });

  /**
   * The resident's own first photo is what the ask was for, so it is what cancels it — a
   * filed report with no photos in it satisfies nothing.
   */
  it("stops asking the resident once they add a photo, and only then", async () => {
    await sweepInspectionReminders(db, now);
    const pending = asQueueRow([...queued.values()].find(row => row.kind === "inspection")!);
    reports = [roomReport()];
    expect(await inspectionReminderIsCurrent(db, pending)).toBe(true);
    reports = [roomReport("manager")];
    expect(await inspectionReminderIsCurrent(db, pending)).toBe(true);
    reports = [roomReport("resident")];
    expect(await inspectionReminderIsCurrent(db, pending)).toBe(false);
    queued.clear();
    await sweepInspectionReminders(db, now);
    expect([...queued.values()].some(row => row.kind === "inspection")).toBe(false);
  });

  /**
   * The per-room "inspection required" toggle is off by default. While it gated the reminders,
   * a resident with an assigned room was effectively never asked for the photos the feature
   * exists to collect.
   */
  it("asks every resident with an assigned room, not only rooms flagged required", async () => {
    rooms[0]!.moveInInspectionRequired = false;
    await sweepInspectionReminders(db, now);
    const resident = [...queued.values()].find(row => row.kind === "inspection");
    expect(resident).toBeDefined();
    expect((resident!.payload as Row).required).toBe(false);
    expect(await inspectionReminderIsCurrent(db, asQueueRow(resident!))).toBe(true);
  });

  it("tells the manager when nobody has photographed the room, and cancels after withdrawal", async () => {
    reports = [roomReport()];
    await sweepInspectionReminders(db, now);
    const review = [...queued.values()].find(row => row.kind === "inspection_manager");
    expect(review).toBeDefined();
    expect(await inspectionReminderIsCurrent(db, asQueueRow(review!))).toBe(true);
    // Either side photographing the room answers the manager notice.
    reports = [roomReport("resident")];
    expect(await inspectionReminderIsCurrent(db, asQueueRow(review!))).toBe(false);
    reports = [roomReport()];
    (application.row_data as Row).withdrawnAt = "2026-09-06T13:00:00Z";
    expect(await inspectionReminderIsCurrent(db, asQueueRow(review!))).toBe(false);
  });
});
