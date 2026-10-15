/**
 * Evidence harness (batch 2, 2026-10-13): the note a manager types on a host
 * block, end to end through the real route and a fake Postgres.
 *
 * Shows the four rules the popup relies on: a note saves on a host block (a
 * range with no guest and no money), a later save that does not carry `notes`
 * leaves it alone, a blank one clears it - deleting the row when the note was
 * the only thing on it, because the server's "has money" check deliberately
 * excludes notes - and two blocks that share ONE Airbnb UID keep their own
 * notes, because a block's row is keyed on the UID plus its dates.
 *
 * Writes a request/response transcript when EVIDENCE_DIR is set.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeSupabaseClient, type Row } from "./helpers/fake-supabase-tables";

vi.mock("server-only", () => ({}));

const MINE = "mgr-1";
const state = vi.hoisted(() => ({ userId: "mgr-1" as string | null, db: null as unknown }));
vi.mock("@/lib/auth/manager-lease-scope", () => ({
  managerCanWriteCalendarForProperty: async () => true,
  managerHasCalendarAccessForProperty: async () => true,
  managerCanWriteCalendarForProperties: async (_db: unknown, _u: string, ids: readonly string[]) => new Set(ids),
}));
vi.mock("@/lib/workspaces/scope.server", () => ({ activeWorkspacePropertyScope: async () => null }));
vi.mock("@/lib/channel-calendar/require-manager.server", () => ({
  requireBookingsManager: async () => (state.userId ? { db: state.db, userId: state.userId } : null),
}));

import { GET, PUT } from "@/app/api/portal/channel-calendar/stay-details/route";

const BLOCK = { id: "echo-1", sourceUid: "echo-1", summary: "Airbnb (Not available)", start: "2026-08-01", end: "2026-08-20", hostBlock: true };
// Airbnb gives every host block on one feed the SAME UID, dates and all.
const SECOND_BLOCK = { ...BLOCK, start: "2026-10-05", end: "2026-10-09" };
const BLOCK_KEY = "echo-1|2026-08-01|2026-08-20";
const SECOND_BLOCK_KEY = "echo-1|2026-10-05|2026-10-09";

let tables: Record<string, Row[]>;
const log: string[] = [];

beforeEach(() => {
  tables = {
    external_calendar_connections: [{
      id: "conn-a", manager_user_id: MINE, property_id: "prop-mine", room_id: "room-a", provider: "airbnb", label: "Room A",
      import_url: "https://www.airbnb.com/calendar/ical/1.ics?s=x", export_token: "tok-a", imported_ranges: [BLOCK, SECOND_BLOCK],
      last_synced_at: null, last_error: null, export_last_fetched_at: null,
    }],
    channel_stay_details: [],
    manager_property_records: [],
  };
  state.db = fakeSupabaseClient(tables);
  state.userId = MINE;
});

async function put(body: unknown, note: string) {
  const res = await PUT(new Request("http://localhost/api/portal/channel-calendar/stay-details", {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  }));
  const json = await res.json();
  log.push(
    `# ${note}`,
    `PUT /api/portal/channel-calendar/stay-details  ${JSON.stringify(body)}`,
    `${res.status} ${JSON.stringify(json)}`,
    `channel_stay_details → ${JSON.stringify(tables.channel_stay_details)}`,
    "",
  );
  return { status: res.status, json };
}

describe("evidence · a host block's note, saved, kept and cleared", () => {
  it("writes the note, leaves it on an unrelated save, and deletes the note-only row when cleared", async () => {
    const ref = { connectionId: "conn-a", sourceUid: "echo-1", start: BLOCK.start, end: BLOCK.end };
    const first = await put({ ...ref, notes: "Closed for the owner's own stay." }, "Block notes → Save on a host block (no guest, no money)");
    expect(first.status).toBe(200);
    expect(first.json).toMatchObject({ notes: "Closed for the owner's own stay." });
    // The row is keyed on the UID PLUS the block's dates, never the shared UID alone.
    expect(tables.channel_stay_details[0]).toMatchObject({ connection_id: "conn-a", source_uid: BLOCK_KEY, notes: "Closed for the owner's own stay.", updated_by: MINE });

    const query = `connectionId=conn-a&sourceUid=echo-1&start=${BLOCK.start}&end=${BLOCK.end}`;
    const read = await GET(new Request(`http://localhost/x?${query}`));
    log.push(
      "# The calendar reads it back on the next load",
      `GET /api/portal/channel-calendar/stay-details?${query}`,
      `${read.status} ${JSON.stringify(await read.clone().json())}`,
      "",
    );
    expect(await read.json()).toMatchObject({ notes: "Closed for the owner's own stay." });

    // The October block shares the August block's UID; its note is its own.
    const second = await put(
      { connectionId: "conn-a", sourceUid: "echo-1", start: SECOND_BLOCK.start, end: SECOND_BLOCK.end, notes: "Bathroom retile." },
      "A second block on the SAME Airbnb UID gets its own note, and leaves the first alone",
    );
    expect(second.status).toBe(200);
    expect(tables.channel_stay_details).toHaveLength(2);
    expect(tables.channel_stay_details.find((row) => row.source_uid === BLOCK_KEY)).toMatchObject({ notes: "Closed for the owner's own stay." });
    expect(tables.channel_stay_details.find((row) => row.source_uid === SECOND_BLOCK_KEY)).toMatchObject({ notes: "Bathroom retile." });
    const octoberRead = await GET(new Request(`http://localhost/x?connectionId=conn-a&sourceUid=echo-1&start=${SECOND_BLOCK.start}&end=${SECOND_BLOCK.end}`));
    expect(await octoberRead.json()).toMatchObject({ notes: "Bathroom retile." });

    await put({ ...ref, guestPhone: "(206) 555-0100" }, "A save that omits notes leaves the note exactly as it was");
    const august = () => tables.channel_stay_details.find((row) => row.source_uid === BLOCK_KEY)!;
    expect(august()).toMatchObject({ notes: "Closed for the owner's own stay." });
    expect(august().guest_phone).toBeTruthy();

    await put({ ...ref, guestPhone: "" }, "Money cleared, note still there: the row stays for the note alone");
    expect(august()).toMatchObject({ notes: "Closed for the owner's own stay." });

    await put({ ...ref, notes: "   " }, "Note blanked and nothing else left: the row is deleted");
    expect(tables.channel_stay_details.map((row) => row.source_uid)).toEqual([SECOND_BLOCK_KEY]);

    const out = process.env.EVIDENCE_DIR ?? "";
    if (out) {
      mkdirSync(out, { recursive: true });
      writeFileSync(`${out}/stay-notes-api-transcript.txt`, `${log.join("\n")}\n`, "utf8");
    }
  });
});
