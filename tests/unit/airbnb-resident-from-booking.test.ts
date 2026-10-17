import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("server-only", () => ({}));

import { airbnbResidentName, upsertAirbnbResidentsFromImportedRanges } from "@/lib/channel-calendar/airbnb-residents.server";
import { applyAirbnbEmailToStay } from "@/lib/channel-calendar/airbnb-email-intake.server";
import {
  residentEntriesFromStays,
  withoutChannelStaysCoveredByResidents,
  occupancyStayResident,
} from "@/lib/occupancy/snapshot";
import type { PropertyBookingEntry } from "@/lib/channel-calendar/property-bookings";

type Row = Record<string, unknown>;

/** Reads `row_data->>key` like PostgREST does; every other column is a plain key. */
function column(row: Row, col: string): unknown {
  const at = col.indexOf("->>");
  if (at < 0) return row[col];
  const data = row[col.slice(0, at)] as Row | undefined;
  return data?.[col.slice(at + 3)];
}

/** Just the chain shapes the resident writers issue: select/eq/limit, upsert (by id or onConflict), update, delete. */
function fakeDb(tables: Record<string, Row[]>): SupabaseClient {
  const from = (table: string) => {
    const master = (tables[table] ??= []);
    let working = [...master];
    let op: "select" | "upsert" | "update" | "delete" = "select";
    let payload: Row = {};
    let conflict = "id";
    const q: Record<string, unknown> = {
      select: () => q,
      limit: () => q,
      eq: (col: string, val: unknown) => {
        working = working.filter((r) => column(r, col) === val);
        return q;
      },
      upsert: (row: Row, opts?: { onConflict?: string }) => {
        op = "upsert";
        payload = row;
        conflict = opts?.onConflict ?? "id";
        return q;
      },
      update: (patch: Row) => {
        op = "update";
        payload = patch;
        return q;
      },
      delete: () => {
        op = "delete";
        return q;
      },
      maybeSingle: async () => ({ data: working[0] ?? null, error: null }),
      then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
        if (op === "upsert") {
          const keys = conflict.split(",").map((k) => k.trim());
          const existing = master.find((r) => keys.every((k) => r[k] === payload[k]));
          if (existing) Object.assign(existing, payload);
          else master.push({ ...payload });
        } else if (op === "update") {
          for (const r of working) Object.assign(r, payload);
        } else if (op === "delete") {
          const ids = new Set(working);
          const rest = master.filter((r) => !ids.has(r));
          master.length = 0;
          master.push(...rest);
        }
        return Promise.resolve({ data: op === "select" ? working : null, error: null }).then(resolve, reject);
      },
    };
    return q;
  };
  return { from } as unknown as SupabaseClient;
}

const baseInput = {
  managerUserId: "mgr-1",
  propertyId: "p1",
  propertyLabel: "Brooklyn",
  roomId: "r1",
  roomLabel: "Room 9",
  connectionId: "c1",
};
const reserved = (extra: Record<string, unknown> = {}) => ({
  id: "uid-1",
  sourceUid: "uid-1",
  summary: "Reserved",
  start: "2099-10-13",
  end: "2099-10-16",
  reservationCode: "HMHW5SHXRB",
  ...extra,
});

describe("airbnbResidentName", () => {
  it("prefers the guest name, then the confirmation code, and is never Reserved", () => {
    expect(airbnbResidentName({ guestName: "Juan Angel", summary: "Reserved", reservationCode: "HMHW5SHXRB" })).toBe("Juan Angel");
    expect(airbnbResidentName({ summary: "Reserved", reservationCode: "HMHW5SHXRB" })).toBe("Airbnb guest · HMHW5SHXRB");
    expect(airbnbResidentName({ guestName: "  ", summary: "Reserved" })).toBe("Airbnb guest");
    for (const name of [
      airbnbResidentName({ summary: "Reserved" }),
      airbnbResidentName({ summary: "Booked" }),
      airbnbResidentName({ summary: "" }),
      airbnbResidentName({ guestName: "", summary: "Reserved", reservationCode: "HMHW5SHXRB" }),
    ]) {
      expect(name.toLowerCase()).not.toBe("reserved");
    }
  });

  it("reads the code out of a reservation URL left in the summary", () => {
    expect(airbnbResidentName({ summary: "https://www.airbnb.com/hosting/reservations/details/HMABCDEFGH" })).toBe("Airbnb guest · HMABCDEFGH");
  });
});

describe("Airbnb sync files a resident per reservation", () => {
  let tables: Record<string, Row[]>;
  beforeEach(() => {
    tables = { manager_application_records: [], channel_stay_details: [] };
  });
  const residents = () => tables.manager_application_records;

  it("names the resident from the code, carries the feed identity, and never says Reserved", async () => {
    const result = await upsertAirbnbResidentsFromImportedRanges(fakeDb(tables), { ...baseInput, ranges: [reserved()] });
    expect(result).toEqual({ created: 1, updated: 0, skipped: 0 });
    const row = residents()[0]!.row_data as Row;
    expect(row.name).toBe("Airbnb guest · HMHW5SHXRB");
    expect(row.icalConnectionId).toBe("c1");
    expect(row.icalSourceUid).toBe("uid-1");
    expect((row.application as Row).fullLegalName).toBe("Airbnb guest · HMHW5SHXRB");
  });

  it("takes channel_stay_details.guest_name over the code label", async () => {
    tables.channel_stay_details.push({ connection_id: "c1", source_uid: "uid-1", guest_name: "Juan Angel" });
    await upsertAirbnbResidentsFromImportedRanges(fakeDb(tables), { ...baseInput, ranges: [reserved()] });
    expect((residents()[0]!.row_data as Row).name).toBe("Juan Angel");
  });

  it("renames a resident an older sync left named Reserved, and a second sync never duplicates", async () => {
    residents().push({
      id: "axis-old",
      manager_user_id: "mgr-1",
      resident_email: "airbnb.c1.uid1@import.proplane.local",
      row_data: { id: "axis-old", name: "Reserved", icalConnectionId: "c1", icalSourceUid: "uid-1", email: "airbnb.c1.uid1@import.proplane.local" },
    });
    const db = fakeDb(tables);
    const first = await upsertAirbnbResidentsFromImportedRanges(db, { ...baseInput, ranges: [reserved()] });
    const second = await upsertAirbnbResidentsFromImportedRanges(db, { ...baseInput, ranges: [reserved()] });
    expect(first.updated).toBe(1);
    expect(second.updated).toBe(1);
    expect(residents()).toHaveLength(1);
    expect((residents()[0]!.row_data as Row).name).toBe("Airbnb guest · HMHW5SHXRB");
  });

  it("files a resident for a Reserved reservation but never for a host block", async () => {
    await upsertAirbnbResidentsFromImportedRanges(fakeDb(tables), {
      ...baseInput,
      ranges: [reserved(), reserved({ id: "uid-b", sourceUid: "uid-b", summary: "Airbnb (Not available)", reservationCode: undefined })],
    });
    expect(residents()).toHaveLength(1);
  });

  it("two reservations stay two residents across repeated syncs", async () => {
    const db = fakeDb(tables);
    const ranges = [reserved(), reserved({ id: "uid-2", sourceUid: "uid-2", reservationCode: "HMZZZZZZZZ", start: "2099-11-01", end: "2099-11-04" })];
    await upsertAirbnbResidentsFromImportedRanges(db, { ...baseInput, ranges });
    await upsertAirbnbResidentsFromImportedRanges(db, { ...baseInput, ranges });
    expect(residents()).toHaveLength(2);
  });
});

describe("Airbnb email names the resident", () => {
  const connection = {
    id: "c1", manager_user_id: "mgr-1", property_id: "p1", room_id: "r1", provider: "airbnb", label: "Room 9", import_url: "https://x", export_token: "t",
    imported_ranges: [reserved()], last_synced_at: null, last_error: null, export_last_fetched_at: null,
  };

  it("renames the matching placeholder resident in the same intake that saves the guest name", async () => {
    const tables: Record<string, Row[]> = {
      external_calendar_connections: [connection],
      channel_stay_details: [],
      manager_application_records: [
        {
          id: "axis-1", manager_user_id: "mgr-1", resident_email: "airbnb.c1.uid1@import.proplane.local",
          row_data: { id: "axis-1", name: "Airbnb guest · HMHW5SHXRB", icalConnectionId: "c1", icalSourceUid: "uid-1", application: {} },
        },
        {
          id: "axis-other", manager_user_id: "mgr-1", resident_email: "airbnb.c1.uid2@import.proplane.local",
          row_data: { id: "axis-other", name: "Someone Else", icalConnectionId: "c1", icalSourceUid: "uid-2", application: {} },
        },
      ],
    };
    const result = await applyAirbnbEmailToStay(
      fakeDb(tables),
      "mgr-1",
      { kind: "booking", confirmationCode: "HMHW5SHXRB", guestFirstName: "Juan" },
      "2099-10-09T00:00:00.000Z",
    );
    expect(result).toEqual({ applied: true, connectionId: "c1", sourceUid: "uid-1" });
    expect(tables.channel_stay_details[0]).toMatchObject({ guest_name: "Juan" });
    const [renamed, untouched] = tables.manager_application_records.map((r) => r.row_data as Row);
    expect(renamed!.name).toBe("Juan");
    expect((renamed!.application as Row).fullLegalName).toBe("Juan");
    expect(untouched!.name).toBe("Someone Else");
  });

  it("never puts the code label back over a name the manager typed, when the mail names nobody", async () => {
    // A payout mail carries no guest name and the feed summary is generic, so the computed name
    // degrades to "Airbnb guest · HM…". Writing that would lose the typed name for good: the next
    // sync recomputes the very same placeholder.
    const tables: Record<string, Row[]> = {
      external_calendar_connections: [connection],
      channel_stay_details: [],
      manager_application_records: [
        {
          id: "axis-1", manager_user_id: "mgr-1", resident_email: "airbnb.c1.uid1@import.proplane.local",
          row_data: { id: "axis-1", name: "Juan Angel", icalConnectionId: "c1", icalSourceUid: "uid-1", application: { fullLegalName: "Juan Angel" } },
        },
      ],
    };
    const result = await applyAirbnbEmailToStay(
      fakeDb(tables),
      "mgr-1",
      { kind: "payout", confirmationCode: "HMHW5SHXRB", payoutCents: 42_000 },
      "2099-10-09T00:00:00.000Z",
    );
    expect(result).toEqual({ applied: true, connectionId: "c1", sourceUid: "uid-1" });
    expect(tables.channel_stay_details[0]).toMatchObject({ payout_cents: 42_000 });
    const row = tables.manager_application_records[0]!.row_data as Row;
    expect(row.name).toBe("Juan Angel");
    expect((row.application as Row).fullLegalName).toBe("Juan Angel");
  });

  it("still fills a placeholder the sync invented, even from a mail that names nobody", async () => {
    const tables: Record<string, Row[]> = {
      external_calendar_connections: [connection],
      channel_stay_details: [{ connection_id: "c1", source_uid: "uid-1", guest_name: "Juan" }],
      manager_application_records: [
        {
          id: "axis-1", manager_user_id: "mgr-1", resident_email: "airbnb.c1.uid1@import.proplane.local",
          row_data: { id: "axis-1", name: "Reserved", icalConnectionId: "c1", icalSourceUid: "uid-1", application: {} },
        },
      ],
    };
    await applyAirbnbEmailToStay(fakeDb(tables), "mgr-1", { kind: "payout", confirmationCode: "HMHW5SHXRB", payoutCents: 1 }, "2099-10-09T00:00:00.000Z");
    expect((tables.manager_application_records[0]!.row_data as Row).name).toBe("Juan");
  });

  it("leaves a resident a real person attached an account to alone", async () => {
    const tables: Record<string, Row[]> = {
      external_calendar_connections: [connection],
      channel_stay_details: [],
      manager_application_records: [
        {
          id: "axis-1", manager_user_id: "mgr-1", resident_email: "juan@example.com",
          row_data: { id: "axis-1", name: "Juan Angel", icalConnectionId: "c1", icalSourceUid: "uid-1", application: {} },
        },
      ],
    };
    await applyAirbnbEmailToStay(fakeDb(tables), "mgr-1", { kind: "booking", confirmationCode: "HMHW5SHXRB", guestFirstName: "Juan" }, "2099-10-09T00:00:00.000Z");
    expect((tables.manager_application_records[0]!.row_data as Row).name).toBe("Juan Angel");
  });
});

describe("the calendar draws a covered reservation once", () => {
  const channel = (extra: Partial<PropertyBookingEntry> = {}): PropertyBookingEntry => ({
    source: "airbnb", propertyId: "p1", propertyLabel: "Brooklyn", roomId: "r1", roomLabel: "Room 9",
    summary: "Reserved", start: "2099-10-13", end: "2099-10-15", sourceUid: "uid-1", connectionId: "c1", reservationCode: "HMHW5SHXRB", ...extra,
  });
  const resident = (extra: Partial<PropertyBookingEntry> = {}): PropertyBookingEntry => ({
    source: "hold", propertyId: "p1", propertyLabel: "Brooklyn", roomId: "r1", roomLabel: "Room 9",
    summary: "Juan", residentName: "Juan", start: "2099-10-13", end: "2099-10-15", applicationId: "axis-1",
    icalConnectionId: "c1", icalSourceUid: "uid-1", ...extra,
  });

  it("drops the channel bar the resident covers and keeps an uncovered one and a host block", () => {
    const uncovered = channel({ sourceUid: "uid-2", start: "2099-11-01", end: "2099-11-03" });
    const block = channel({ sourceUid: "uid-1", summary: "Airbnb (Not available)", start: "2099-12-01", end: "2099-12-05" });
    const out = withoutChannelStaysCoveredByResidents([channel(), resident(), uncovered, block]);
    expect(out).toEqual([resident(), uncovered, block]);
  });

  it("keeps the channel stay when nothing covers it, and when the resident belongs to another feed", () => {
    expect(withoutChannelStaysCoveredByResidents([channel()])).toEqual([channel()]);
    expect(withoutChannelStaysCoveredByResidents([channel(), resident({ icalConnectionId: "c-other" })])).toHaveLength(2);
  });

  it("does not mutate its input, so the record page's list still has the channel stay", () => {
    const all = [channel(), resident()];
    withoutChannelStaysCoveredByResidents(all);
    expect(all).toHaveLength(2);
  });

  it("the feed identity survives the occupancy snapshot round trip", () => {
    const payload = occupancyStayResident(resident());
    expect(payload).toMatchObject({ icalConnectionId: "c1", icalSourceUid: "uid-1" });
    const [back] = residentEntriesFromStays(
      [{ propertyId: "p1", roomId: "r1", roomLabel: "Room 9", start: "2099-10-13", end: "2099-10-15", name: "Juan", resident: payload }],
      () => "Brooklyn",
    );
    expect(back).toMatchObject({ icalConnectionId: "c1", icalSourceUid: "uid-1" });
    expect(withoutChannelStaysCoveredByResidents([channel(), back!])).toHaveLength(1);
  });
});
